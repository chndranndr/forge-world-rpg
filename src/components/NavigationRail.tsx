export type RailTarget = "library" | "session" | "settings";

export interface RailWorld {
  gameId: string;
  title: string;
  meta: string;
  sessionId?: string;
}

interface NavigationRailProps {
  active: RailTarget;
  canOpenSession: boolean;
  recent: RailWorld[];
  onNavigate: (target: RailTarget) => void;
  onOpenWorld: (world: RailWorld) => void;
  hideOnMobile?: boolean;
}

const LINKS: { id: RailTarget; label: string; short: string }[] = [
  { id: "library", label: "Perpustakaan", short: "Lib" },
  { id: "session", label: "Sesi", short: "Sesi" },
  { id: "settings", label: "Pengaturan", short: "Atur" },
];

export default function NavigationRail({
  active,
  canOpenSession,
  recent,
  onNavigate,
  onOpenWorld,
  hideOnMobile = false,
}: NavigationRailProps) {
  return (
    <aside className={`rail texture${hideOnMobile ? " rail-session" : ""}`}>
      <a
        className="brand"
        href="#perpustakaan"
        onClick={(event) => {
          event.preventDefault();
          onNavigate("library");
        }}
      >
        <span className="mark" aria-hidden="true">
          F
        </span>
        <span>
          <b>Fworld</b>
          <small>Ruang cerita</small>
        </span>
      </a>
      <p className="rail-label">Jelajahi</p>
      <nav aria-label="Navigasi utama">
        {LINKS.map((link) => {
          const disabled = link.id === "session" && !canOpenSession;
          return (
            <button
              key={link.id}
              type="button"
              className={`nav${active === link.id ? " active" : ""}`}
              data-short={link.short}
              aria-current={active === link.id ? "page" : undefined}
              disabled={disabled}
              title={disabled ? "Belum ada sesi tersimpan" : undefined}
              onClick={() => onNavigate(link.id)}
            >
              {link.label}
            </button>
          );
        })}
      </nav>
      <p className="rail-label recent-label">Dunia terakhir</p>
      {recent.map((world) => (
        <button
          key={world.gameId}
          type="button"
          className="recent"
          onClick={() => onOpenWorld(world)}
        >
          {world.title}
          <small>{world.meta}</small>
        </button>
      ))}
      {recent.length === 0 && (
        <p className="recent-empty">Belum ada dunia tersimpan.</p>
      )}
      <div className="rail-foot">
        <i aria-hidden="true" /> Data tersimpan lokal
      </div>
    </aside>
  );
}
