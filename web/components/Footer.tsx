export default function Footer() {
  return (
    <footer className="mx-auto max-w-5xl px-6 py-8 text-center text-xs text-slate-500">
      <p>
        Tu llave <code className="rounded bg-slate-100 px-1.5 py-0.5">gw_…</code>{" "}
        nunca se guarda en el servidor. Se envía únicamente a este sitio para
        reenviarla al gateway durante la generación.
      </p>
    </footer>
  );
}
