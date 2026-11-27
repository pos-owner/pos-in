import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { charges, db, meterReadings, payments, profiles, type Tx } from "../../db/index.ts";
import { bindings, env, hasBinding } from "../core/bindings.ts";
import { addMonths, monthOf, todayIST } from "../core/util.ts";
import { syncChargeStatus } from "./data.ts";

/*
 * Meter photos are read by Workers AI (binding AI) with a vision model. Without the binding, scanning is reported
 * as unavailable and people type the reading instead. METER_AI_MODEL overrides the model.
 */
export const meterAiEnabled = () => hasBinding("AI") && env("METER_AI") !== "off";
const MODEL = () => env("METER_AI_MODEL") ?? "@cf/meta/llama-4-scout-17b-16e-instruct";

export type MeterKind = "electricity" | "water";

interface MeterGuess {
  reading: number | null;
  confidence: number;
  note: string;
}

function base64(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Pulls the first JSON object out of a model reply (models sometimes wrap it in prose or code fences). */
function parseGuess(raw: unknown): MeterGuess {
  let j: Partial<MeterGuess> | null = null;
  if (raw && typeof raw === "object") j = raw as Partial<MeterGuess>;
  else if (typeof raw === "string") {
    const m = raw.match(/\{[\s\S]*\}/);
    try {
      j = m ? (JSON.parse(m[0]) as Partial<MeterGuess>) : null;
    } catch {
      j = null;
    }
  }
  if (!j) return { reading: null, confidence: 0, note: "Couldn't read this photo. Type the number instead." };
  const n = typeof j.reading === "string" ? Number(j.reading) : j.reading;
  const reading = typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null;
  const confidence = typeof j.confidence === "number" ? Math.min(1, Math.max(0, j.confidence)) : 0;
  return { reading, confidence: reading === null ? 0 : confidence, note: String(j.note ?? "").slice(0, 120) };
}

/** Reads the register value from a meter photo. The person always confirms or corrects it. */
export async function readMeterPhoto(bytes: ArrayBuffer, mimeType: string, kind: MeterKind): Promise<MeterGuess> {
  const prompt = [
    `This is a photo of an ${kind === "water" ? "water" : "electricity"} meter in India.`,
    "Read the main cumulative register shown on the meter display or dial counter.",
    kind === "electricity"
      ? "Use the total energy reading in kWh. Ignore voltage, current, time, date, meter serial numbers and maximum-demand screens."
      : "Use the total volume (cubic metres or litres as shown on the main counter). Ignore the serial number and small sub-dials unless they are the decimal part.",
    "Include digits after the decimal point only if the meter clearly shows them (often red digits or after a dot).",
    "If you cannot see a meter reading clearly, return null for reading.",
    "confidence is your probability (0 to 1) that the reading is exactly right. note is a short plain-English remark for the user (max 80 characters).",
    'Reply with JSON only, shaped like {"reading": 12345.6, "confidence": 0.9, "note": "..."}.',
  ].join(" ");
  const ai = bindings().AI;
  if (!ai) throw new Error("Workers AI binding missing");
  const res = (await ai.run(
    MODEL() as never,
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64(bytes)}` } },
          ],
        },
      ],
      max_tokens: 200,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            reading: { type: ["number", "null"] },
            confidence: { type: "number" },
            note: { type: "string" },
          },
          required: ["reading", "confidence", "note"],
        },
      },
    } as never,
  )) as { response?: unknown };
  return parseGuess(res?.response ?? res);
}

export async function lastReading(unitId: number, kind: MeterKind) {
  const [r] = await db
    .select()
    .from(meterReadings)
    .where(and(eq(meterReadings.unitId, unitId), eq(meterReadings.kind, kind)))
    .orderBy(desc(meterReadings.readOn), desc(meterReadings.id))
    .limit(1);
  return r ?? null;
}

/** Usage of the unit's last few readings of this meter (for the sanity check). */
export async function recentUsage(unitId: number, kind: MeterKind, n = 3) {
  const rows = await db
    .select({ usage: meterReadings.usage })
    .from(meterReadings)
    .where(and(eq(meterReadings.unitId, unitId), eq(meterReadings.kind, kind), gt(meterReadings.usage, 0)))
    .orderBy(desc(meterReadings.readOn), desc(meterReadings.id))
    .limit(n);
  return rows.map((r) => r.usage ?? 0);
}

/** The owner's default utility rates (paise per unit). */
export async function rates(ownerId: string) {
  const [p] = await db
    .select({ e: profiles.electricityRate, w: profiles.waterRate })
    .from(profiles)
    .where(eq(profiles.id, ownerId));
  return { electricity: p?.e ?? 0, water: p?.w ?? 0 };
}

export { billFor, effectiveRates, unusualUsage } from "./billing.ts";

/*
 * Bills move with `meter_readings.charge_id`. The `meter_bill_*` triggers (in the initial migration) add
 * the reading's amount to the charge when the link is set and take it off when it is cleared, inside the same
 * statement. D1 runs each statement atomically and one at a time, so one conditional UPDATE decides and writes at
 * once: a double tap, a parallel delete or a payment arriving meanwhile can never apply a bill twice or leave the
 * link and the money out of step. `tx` parameters take the shared db handle; D1 has no interactive transactions.
 */

/** Confirmed payments on a charge, as SQL (for guards evaluated inside an UPDATE). */
const confirmedOn = (chargeId: unknown) =>
  sql`coalesce((select sum(${payments.amount}) from ${payments} where ${payments.chargeId} = ${chargeId} and ${payments.status} = 'confirmed'), 0)`;

/**
 * Adds a reading's bill to the rent charge of its month (or the next month's charge once it exists). Idempotent: a
 * reading is linked to at most one charge.
 */
export async function applyBillToRent(
  readingId: number,
  tenancyId: number,
  _tx?: Tx,
): Promise<typeof charges.$inferSelect | null> {
  const [r] = await db.select().from(meterReadings).where(eq(meterReadings.id, readingId));
  if (!r || r.chargeId || r.amount <= 0) return null;
  const month = monthOf(r.readOn ?? todayIST());
  const [found] = await db
    .select({ id: charges.id })
    .from(charges)
    .where(and(eq(charges.tenancyId, tenancyId), inArray(charges.month, [month, addMonths(month, 1)])))
    .orderBy(charges.month)
    .limit(1);
  if (!found) return null;
  const linked = await db
    .update(meterReadings)
    .set({ chargeId: found.id })
    .where(and(eq(meterReadings.id, r.id), isNull(meterReadings.chargeId), gt(meterReadings.amount, 0)))
    .returning({ id: meterReadings.id });
  if (!linked.length) return null;
  await syncChargeStatus(found.id);
  const [ch] = await db.select().from(charges).where(eq(charges.id, found.id));
  return ch ?? null;
}

/**
 * Undo: removes a reading's bill from its charge.
 * "none" when the reading has no bill on the rent. "overpaid" when confirmed payments already exceed what the
 * rent would be without this bill; nothing changes then, and the owner voids a payment first. (`computeStatus`
 * clamps the balance at zero, so an overpaid charge would otherwise just show "paid".)
 */
export async function removeBillFromRent(readingId: number, _tx?: Tx): Promise<"removed" | "none" | "overpaid"> {
  const [r] = await db.select().from(meterReadings).where(eq(meterReadings.id, readingId));
  if (!r?.chargeId) return "none";
  const chargeId = r.chargeId;
  // The overpaid check is part of the UPDATE, so a payment confirmed a moment earlier is always counted.
  const unlinked = await db
    .update(meterReadings)
    .set({ chargeId: null })
    .where(
      and(
        eq(meterReadings.id, r.id),
        eq(meterReadings.chargeId, chargeId),
        sql`max(0, (select ${charges.amount} from ${charges} where ${charges.id} = ${chargeId}) - ${meterReadings.amount}) >= ${confirmedOn(chargeId)}`,
      ),
    )
    .returning({ id: meterReadings.id });
  if (unlinked.length) {
    await syncChargeStatus(chargeId);
    return "removed";
  }
  const [now] = await db.select().from(meterReadings).where(eq(meterReadings.id, r.id));
  return now?.chargeId === chargeId ? "overpaid" : "none";
}
