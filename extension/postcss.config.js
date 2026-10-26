import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";

// Tailwind sizes are in rem, which follows the *page's* root font size. Meeting sites can
// change it, so convert rem to px to keep the overlay the same size everywhere.
const remToPx = {
  postcssPlugin: "mayami-rem-to-px",
  Declaration(decl) {
    if (decl.value.includes("rem")) {
      decl.value = decl.value.replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${parseFloat(n) * 16}px`);
    }
  },
};

export default {
  plugins: [tailwindcss(), remToPx, autoprefixer()],
};
