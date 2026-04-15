import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QGen — Generador de preguntas desde PDF",
  description:
    "Sube un PDF y genera automáticamente un cuestionario con respuestas esperadas usando tu llave del gateway LLM.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
