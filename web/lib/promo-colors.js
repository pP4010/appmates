/**
 * The palette a promoted rail slot can be requested in — muted, deep tones
 * rather than a bright candy palette, closer to what a marketplace like
 * trustmrr.com uses for its sponsor cards. Kept in sync by hand with the
 * `.rail-card--*` rules in `landing.css`, and with `PROMO_COLORS` in
 * `community/src/lib/config.js` — ten is few enough that a shared lookup
 * table across the JS/CSS/server boundary would cost more to read than it
 * saves.
 *
 * Single source for both the landing rail's own card colours and the
 * promo-request form's swatch picker — `landing.js` and `lib/promo-form.js`
 * both import this instead of keeping their own copies.
 */
export const RAIL_COLORS = [
  { id: 'blue', label: 'Blue', hex: '#2f5fa8' },
  { id: 'green', label: 'Green', hex: '#1f7a4d' },
  { id: 'violet', label: 'Violet', hex: '#6d3aa8' },
  { id: 'orange', label: 'Orange', hex: '#b5502a' },
  { id: 'pink', label: 'Pink', hex: '#8a2f4a' },
  { id: 'teal', label: 'Teal', hex: '#2c6470' },
  { id: 'red', label: 'Red', hex: '#a8342f' },
  { id: 'amber', label: 'Amber', hex: '#a87e1f' },
  { id: 'indigo', label: 'Indigo', hex: '#4340a0' },
  { id: 'slate', label: 'Slate', hex: '#4a5568' },
];
