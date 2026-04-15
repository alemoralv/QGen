export default function Header() {
  return (
    <header className="w-full border-b border-white/60 bg-white/50 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white shadow-soft">
            <span className="text-lg font-bold">Q</span>
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">QGen</p>
            <p className="text-xs text-slate-500">
              Generador de preguntas desde PDF
            </p>
          </div>
        </div>
        <span className="pill">Gateway LLM</span>
      </div>
    </header>
  );
}
