import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        brand: {
          // <alpha-value> habilita opacidad (text-brand-foreground/70, bg-brand/10)
          // sin romper los usos sólidos. Necesario para unificar el color de texto
          // sobre la marca (sidebar/topbar) al valor WCAG-safe --brand-foreground.
          DEFAULT: "hsl(var(--brand) / <alpha-value>)",
          foreground: "hsl(var(--brand-foreground) / <alpha-value>)",
          dark: "hsl(var(--brand-dark) / <alpha-value>)",
          light: "hsl(var(--brand-light) / <alpha-value>)",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      // Escala de elevación suave (Linear/Vercel). Color azul-gris (#101828) en
      // vez de negro puro → sombras más limpias, menos "sucias". Baja opacidad,
      // multi-capa. Reemplaza el shadow-sm plano que daba el aspecto "viejo".
      boxShadow: {
        xs: "0 1px 2px 0 rgb(16 24 40 / 0.04)",
        sm: "0 1px 2px 0 rgb(16 24 40 / 0.05), 0 1px 3px 0 rgb(16 24 40 / 0.04)",
        DEFAULT: "0 1px 3px 0 rgb(16 24 40 / 0.06), 0 4px 8px -2px rgb(16 24 40 / 0.05)",
        md: "0 2px 4px -1px rgb(16 24 40 / 0.06), 0 8px 16px -4px rgb(16 24 40 / 0.06)",
        lg: "0 4px 8px -2px rgb(16 24 40 / 0.07), 0 12px 24px -6px rgb(16 24 40 / 0.08)",
        xl: "0 8px 16px -4px rgb(16 24 40 / 0.08), 0 20px 32px -8px rgb(16 24 40 / 0.10)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "progress-indeterminate": {
          "0%":   { transform: "translateX(-100%) scaleX(0.4)" },
          "40%":  { transform: "translateX(0%)    scaleX(0.4)" },
          "100%": { transform: "translateX(100%)  scaleX(0.6)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "progress-indeterminate": "progress-indeterminate 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
