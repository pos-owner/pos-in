import type { AgreementModel } from "./models.ts";
import { INK, MUTED, Writer, dateLong, inr, newDoc, ordinal, safe } from "./writer.ts";

/** A4 rental agreement draft from the tenancy details. */
export async function renderAgreement(m: AgreementModel): Promise<Uint8Array> {
  const { doc, font, bold } = await newDoc(`Rental agreement ${m.number}`);
  const w = new Writer(doc, font, bold);
  w.brand("Rental agreement", m.number, `Prepared ${dateLong(m.today)}`);

  w.para(`This Rental Agreement is made at ${m.place} on ${dateLong(m.today)} between:`, { after: 8 });
  w.para(`${m.landlord}${m.ownerPhone ? `, phone ${m.ownerPhone}` : ""} (the "Landlord"), and`, {
    bold: true,
    indent: 14,
  });
  w.para(
    `${m.tenantName}${m.tenantPhone ? `, phone ${m.tenantPhone}` : ""}${m.tenantIdNote ? `, ID: ${m.tenantIdNote}` : ""} (the "Tenant").`,
    { bold: true, indent: 14, after: 10 },
  );

  const elec = m.electricityRate;
  const water = m.waterRate;
  const clauses: [string, string][] = [
    [
      "Premises",
      `The Landlord lets to the Tenant the residential premises known as ${m.unitLabel} (${m.unitType}) at ${m.propertyName}${m.address ? `, ${m.address}` : ""} (the "Premises"), for residential use only.`,
    ],
    [
      "Term",
      `${m.months} months, from ${dateLong(m.startDate)} to ${dateLong(m.endDate)}. The term may be renewed by mutual written consent, with any revision of rent agreed at renewal.`,
    ],
    [
      "Rent",
      `${inr(m.rent)} (${m.rentWords}) per month, payable in advance on or before the ${ordinal(m.dueDay)} day of each month${m.ownerUpi ? ` by UPI to ${m.ownerUpi}` : ""}, by bank transfer, or in cash against a receipt.`,
    ],
    [
      "Security deposit",
      `The Tenant has paid an interest-free, refundable security deposit of ${inr(m.deposit)} (${m.depositWords}). It will be refunded when the Premises are handed back, after deducting unpaid rent, utility dues and the cost of repairing any damage beyond normal wear and tear.`,
    ],
    [
      "Utilities",
      `Electricity${water ? " and water are" : " is"} charged by meter reading${elec ? ` at Rs. ${elec} per unit` : ""}${water ? ` and Rs. ${water} per unit of water` : ""}, added to the monthly rent. Other charges agreed in writing are paid by the Tenant.`,
    ],
    [
      "Maintenance",
      "The Tenant will keep the Premises clean and in good condition, report repairs promptly, and not make structural changes without written consent. The Landlord will carry out major and structural repairs within a reasonable time.",
    ],
    [
      "Use and conduct",
      "The Tenant will not sublet, assign or part with possession of the Premises, will not use them for any illegal or commercial purpose, and will respect the neighbours and the rules of the building or society.",
    ],
    [
      "Inspection",
      "The Landlord may inspect the Premises at a reasonable time after giving the Tenant at least 24 hours' notice.",
    ],
    [
      "Notice and termination",
      "Either party may end this agreement by giving one month's written notice. If rent is unpaid for two consecutive months, the Landlord may end the agreement after giving notice. At the end of the tenancy the Tenant will hand back the Premises with all keys and fittings.",
    ],
    [
      "Governing law",
      "This agreement is governed by the laws of India. Disputes will first be settled by discussion, failing which the courts having jurisdiction over the Premises will decide.",
    ],
  ];
  clauses.forEach(([h, body], i) => {
    w.ensure(60);
    w.para(`${i + 1}. ${h}`, { bold: true, size: 10.5, after: 0 });
    w.para(body, { indent: 14, after: 8 });
  });

  w.gap(10);
  w.para("Signed by the parties on the date written above, in the presence of the witnesses below.", { after: 30 });
  w.ensure(120);
  const col = (x: number, label: string, name: string) => {
    w.page.drawLine({ start: { x: w.m + x, y: w.y }, end: { x: w.m + x + 200, y: w.y }, thickness: 0.8, color: INK });
    w.page.drawText(safe(label), { x: w.m + x, y: w.y - 12, size: 8.5, font, color: MUTED });
    w.page.drawText(safe(name), { x: w.m + x, y: w.y - 24, size: 10, font: bold, color: INK });
  };
  col(0, "Landlord", m.landlord);
  col(w.w - 200, "Tenant", m.tenantName);
  w.y -= 80;
  col(0, "Witness 1", "Name and address");
  col(w.w - 200, "Witness 2", "Name and address");
  w.y -= 40;
  w.footer(
    "Draft prepared by pOS from the tenancy details. Print on stamp paper and register as required in your state.",
  );
  return doc.save();
}
