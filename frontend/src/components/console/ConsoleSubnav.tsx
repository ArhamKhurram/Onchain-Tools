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
    <div className="oct-subnav shrink-0 flex items-center gap-tight px-comfy sm:px-roomy py-snug overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          data-active={active === tab.id}
          className="oct-subnav-tab shrink-0 type-label font-mono uppercase tracking-[0.1em] px-comfy py-snug"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
