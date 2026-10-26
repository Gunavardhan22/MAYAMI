/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/content/**/*.{ts,tsx}"],
  // Preflight targets html/body, which don't exist inside the shadow root; the overlay's
  // own base styles live in src/content/styles.css instead.
  corePlugins: { preflight: false },
  theme: {
    extend: {
      fontFamily: { sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"] },
      colors: {
        glass: "rgba(18, 18, 22, 0.88)",
        edge: "rgba(255, 255, 255, 0.10)",
      },
    },
  },
};
