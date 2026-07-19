interface ConsoleSubnavTab<T extends string> {
  id: T;
  label: string;
}

interface ConsoleSubnavProps<T extends string> {
  tabs: ConsoleSubnavTab<T>[];
  active: T;
  onChange: (id: T) => void;
}

export default function ConsoleSubnav<T extends string>({ tabs, active, onChange }: ConsoleSubnavProps<T>) {
  return (
    <div className="shrink-0 flex items-center gap-1 px-4 sm:px-6 py-2 border-b-2 border-black bg-black">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`font-mono text-[10px] sm:text-xs uppercase tracking-[0.12em] px-3 py-1.5 border-2 transition-colors ${
            active === tab.id
              ? 'border-oct-accent text-oct-accent bg-oct-accent/10'
              : 'border-transparent text-oct-muted hover:text-oct-text hover:border-oct-border'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
