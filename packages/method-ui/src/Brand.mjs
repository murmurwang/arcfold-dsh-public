import React from 'react';

// Visuals only: the native parent owns navigation, permissions and focus.
export function BrandMark({ size = 24, className }) {
  return React.createElement('svg', { width: size, height: size, viewBox: '0 0 32 32',
    className, fill: 'none', 'aria-hidden': true, focusable: false,
    style: { flexShrink: 0, color: 'inherit' } },
    React.createElement('path', { d: 'M5 26 16 5l11 21M10 19h12M16 5v21',
      stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' }));
}
export function BrandName() { return React.createElement('span', null, 'Arcfold'); }
export function installBrand(ctx) {
  for (const [name, component] of [
    ['sidebar.brand.mark', BrandMark], ['sidebar.brand.name', BrandName],
    ['conversation.hero.brand.mark', BrandMark],
  ]) ctx.slots.inject(name, () => ctx.slots.register({ name }, component));
}
