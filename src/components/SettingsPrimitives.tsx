export type DataStatus = "checking" | "ready" | "unavailable";
export type SettingsTextSize = "normal" | "large";

const TEXT_SIZE_OPTIONS: { value: SettingsTextSize; label: string }[] = [
  { value: "normal", label: "Standar" },
  { value: "large", label: "Besar" },
];

interface DataStatusRowProps {
  status: DataStatus;
  error: string | null;
}

export function DataStatusRow({ status, error }: DataStatusRowProps) {
  const label =
    status === "ready"
      ? "Tersimpan lokal"
      : status === "checking"
        ? "Memeriksa…"
        : "Tidak tersedia";
  return (
    <section aria-label="Status data" aria-live="polite">
      <div className="setting-row">
        <span>Data</span>
        <span
          className={
            status === "unavailable" ? "status status-error" : "status"
          }
        >
          {label}
        </span>
      </div>
      {status === "unavailable" && error ? (
        <p className="error" role="alert">
          Data lokal tidak dapat dibaca: {error}
        </p>
      ) : null}
    </section>
  );
}

interface TextSizeControlProps {
  value: SettingsTextSize;
  onChange: (value: SettingsTextSize) => void;
}

export function TextSizeControl({ value, onChange }: TextSizeControlProps) {
  return (
    <div className="setting-row">
      <span id="text-size-label">Ukuran teks cerita</span>
      <div
        className="segmented"
        role="radiogroup"
        aria-labelledby="text-size-label"
      >
        {TEXT_SIZE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={option.value === value ? "selected" : undefined}
          >
            <input
              type="radio"
              name="text-size"
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
