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
    <div className="oct-subnav shrink-0 flex items-center gap-1 px-3 sm:px-5 py-2 overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          data-active={active === tab.id}
          className="oct-subnav-tab shrink-0 font-mono text-xs sm:text-[13px] font-semibold uppercase tracking-[0.1em] px-3.5 py-1.5"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
