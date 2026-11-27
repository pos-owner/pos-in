import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import { I } from "./icons";
import { Spinner, useToast } from "./kit";
import { uploadPhoto } from "../lib/photo";
import { tr } from "../lib/i18n";
import "../styles/ops.css";

interface PickedPhoto {
  id: string;
  preview: string;
  key?: string;
  /** "offline": kept on the phone to go out with an offline outbox entry (only with `keepOffline`). */
  state: "uploading" | "done" | "error" | "offline";
  file?: File;
}

/**
 * Uploads photos as soon as they're picked, so sending a request or comment is instant. With `keepOffline` (forms
 * that can save to the offline outbox), a photo picked with no connection is kept instead and listed in `offline`,
 * for the outbox to upload when the connection is back.
 */
export function usePhotos(max = 6, { keepOffline = false }: { keepOffline?: boolean } = {}) {
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const toast = useToast();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const count = useRef(0);
  count.current = photos.length;

  const add = useCallback(
    (files: FileList | File[] | null) => {
      const list = Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
      const room = Math.max(0, max - count.current);
      if (list.length > room) toast(tr("You can add up to {n} photos", { n: max }), "alert");
      const offline = keepOffline && navigator.onLine === false;
      const picked = list.slice(0, room).map((file) => ({
        id: Math.random().toString(36).slice(2),
        preview: URL.createObjectURL(file),
        state: offline ? ("offline" as const) : ("uploading" as const),
        file,
      }));
      if (!picked.length) return;
      count.current += picked.length;
      setPhotos((cur) => [...cur, ...picked]);
      if (offline) return;
      for (const p of picked) {
        uploadPhoto(p.file)
          .then(
            (u) =>
              alive.current &&
              setPhotos((xs) => xs.map((x) => (x.id === p.id ? { ...x, key: u.key, state: "done" as const } : x))),
          )
          .catch((e) => {
            if (!alive.current) return;
            // The connection dropped: keep the photo for the outbox rather than losing it.
            const lost = keepOffline && (!(e instanceof ApiError) || e.status === 0);
            setPhotos((xs) =>
              xs.map((x) => (x.id === p.id ? { ...x, state: lost ? ("offline" as const) : ("error" as const) } : x)),
            );
            if (!lost) toast(e instanceof ApiError ? e.message : "A photo couldn't be uploaded", "alert");
          });
      }
    },
    [max, toast, keepOffline],
  );

  const remove = useCallback((id: string) => {
    setPhotos((xs) => {
      const p = xs.find((x) => x.id === id);
      if (p) URL.revokeObjectURL(p.preview);
      return xs.filter((x) => x.id !== id);
    });
  }, []);
  const reset = useCallback(() => {
    setPhotos((xs) => {
      xs.forEach((x) => URL.revokeObjectURL(x.preview));
      return [];
    });
  }, []);

  return {
    photos,
    add,
    remove,
    reset,
    keys: photos.filter((p) => p.state === "done" && p.key).map((p) => p.key!),
    /** Photos kept on the phone, to be uploaded by the outbox. */
    offline: photos.filter((p) => p.state === "offline" && p.file).map((p) => p.file!),
    uploading: photos.some((p) => p.state === "uploading"),
    full: photos.length >= max,
  };
}

export function Thumb({ p, onRemove, size }: { p: PickedPhoto; onRemove: () => void; size?: number }) {
  return (
    <div className="thumb" style={size ? { width: size } : undefined}>
      <img
        src={p.preview}
        alt=""
        style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 14, display: "block" }}
      />
      {p.state !== "done" && (
        <div
          className={`thumb-state ${p.state === "error" ? "err" : ""}`}
          title={p.state === "offline" ? tr("Uploaded when you're back online") : undefined}
        >
          {p.state === "error" ? <I.alert /> : p.state === "offline" ? <I.cloudUp /> : <Spinner size={22} />}
        </div>
      )}
      <button type="button" className="thumb-x" aria-label={tr("Remove photo")} onClick={onRemove}>
        <I.x />
      </button>
    </div>
  );
}

/** Grid of picked photos with an "add" tile that opens the camera or gallery. */
export function PhotoGrid({ ctl }: { ctl: ReturnType<typeof usePhotos> }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="photos">
      {ctl.photos.map((p) => (
        <Thumb key={p.id} p={p} onRemove={() => ctl.remove(p.id)} />
      ))}
      {!ctl.full && (
        <button
          type="button"
          className="ph"
          onClick={() => input.current?.click()}
          aria-label={tr("Add photos")}
          style={{ border: "1.5px dashed var(--separator)" }}
        >
          <I.camera />
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          ctl.add(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
