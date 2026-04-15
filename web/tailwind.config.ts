import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef6ff",
          100: "#dbe9ff",
          200: "#bfd6ff",
          300: "#93b9ff",
          400: "#6592ff",
          500: "#416efa",
          600: "#2a52e6",
          700: "#2341c1",
          800: "#20389a",
          900: "#1e3179",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      boxShadow: {
        soft: "0 10px 30px -12px rgba(30, 49, 121, 0.25)",
      },
    },
  },
  plugins: [],
};

export default config;
