const gridBg = {
  backgroundImage:
    "linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)",
  backgroundSize: "40px 40px",
};

interface NotFoundViewProps {
  path: string;
}

export default function NotFoundView({ path }: NotFoundViewProps) {
  return (
    <div className="min-h-dvh w-full bg-brand-bg text-zinc-300 font-sans flex items-center justify-center relative overflow-hidden">
      <div style={gridBg} className="absolute inset-0 pointer-events-none" />
      <div className="absolute top-[-120px] left-1/3 w-[600px] h-[300px] bg-brand-accent/[0.05] blur-[120px] rounded-full pointer-events-none" />

      <div className="relative w-full max-w-lg mx-6">
        <div className="border border-brand-border bg-zinc-950/60">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-brand-border bg-zinc-900/60">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 bg-brand-border" />
              <span className="w-2 h-2 bg-brand-border" />
              <span className="w-2 h-2 bg-brand-accent" />
            </div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">
              gametrack // error
            </p>
          </div>

          <div className="px-8 py-12 md:py-14 text-center space-y-6">
            <p className="flex items-center justify-center gap-2 text-[11px] font-black uppercase tracking-widest text-brand-accent">
              <span className="w-1.5 h-1.5 bg-brand-accent" />
              Status Code 404
            </p>
            <h1 className="text-7xl md:text-8xl font-black tracking-tighter leading-none text-white">
              404<span className="text-brand-accent">.</span>
            </h1>
            <p className="text-2xl md:text-3xl font-black tracking-tight uppercase text-white">
              Entry Not Found
            </p>
            <p className="text-xs text-brand-muted leading-relaxed">
              The route <span className="text-brand-accent">{path}</span> does not
              exist in the registry. Check the address or return to the terminal.
            </p>
            <div className="pt-2">
              <a
                href="/"
                className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-brand-accent hover:bg-brand-accent-hover active:scale-[0.98] text-brand-accent-ink text-xs font-sans font-black uppercase tracking-widest rounded-none transition-all"
              >
                Return to the Registry
              </a>
            </div>
          </div>

          <div className="px-4 py-2 border-t border-brand-border bg-zinc-900/40 flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-widest text-brand-muted">
              gametrack // terminal
            </p>
            <p className="text-[10px] uppercase tracking-widest text-brand-accent">
              signal_lost.exe
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
