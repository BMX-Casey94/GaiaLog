"use client"

import React, { useEffect, ReactNode } from 'react';

interface GlowCardProps {
  children: ReactNode;
  className?: string;
  glowColor?: 'blue' | 'purple' | 'green' | 'red' | 'orange' | 'cyan';
  size?: 'sm' | 'md' | 'lg';
  width?: string | number;
  height?: string | number;
  customSize?: boolean; // When true, ignores size prop and uses width/height or className
  disableGlow?: boolean;
}

const glowColorMap = {
  blue: { base: 220, spread: 200 },
  purple: { base: 280, spread: 300 },
  green: { base: 120, spread: 200 },
  red: { base: 0, spread: 200 },
  orange: { base: 30, spread: 200 },
  cyan: { base: 190, spread: 180 },
};

const sizeMap = {
  sm: 'w-48 h-64',
  md: 'w-64 h-80',
  lg: 'w-80 h-96',
};

// Shared, ref-counted pointer tracker on `:root` so 20+ cards never attach
// 20+ document listeners or mutate styles on every card per pointermove.
// Only runs on fine-pointer hover-capable devices and ignores touch input.
let activeGlowCards = 0;
let rafId: number | null = null;
let pendingX = -9999;
let pendingY = -9999;
let listenerAttached = false;

function flushPointerPosition() {
  rafId = null;
  const root = document.documentElement;
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  root.style.setProperty('--glow-x', pendingX.toFixed(1));
  root.style.setProperty('--glow-xp', (pendingX / w).toFixed(3));
  root.style.setProperty('--glow-y', pendingY.toFixed(1));
  root.style.setProperty('--glow-yp', (pendingY / h).toFixed(3));
}

function handlePointerMove(e: PointerEvent) {
  if (e.pointerType === 'touch') return;
  pendingX = e.clientX;
  pendingY = e.clientY;
  if (rafId === null) {
    rafId = window.requestAnimationFrame(flushPointerPosition);
  }
}

function subscribeGlowPointer() {
  if (typeof window === 'undefined') return () => {};
  const finePointer =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (!finePointer) return () => {};

  activeGlowCards += 1;
  if (!listenerAttached) {
    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    listenerAttached = true;
  }

  return () => {
    activeGlowCards = Math.max(0, activeGlowCards - 1);
    if (activeGlowCards === 0 && listenerAttached) {
      document.removeEventListener('pointermove', handlePointerMove);
      listenerAttached = false;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    }
  };
}

const GlowCard: React.FC<GlowCardProps> = ({
  children,
  className = '',
  glowColor = 'blue',
  size = 'md',
  width,
  height,
  customSize = false,
  disableGlow = false,
}) => {
  useEffect(() => {
    if (disableGlow) return;
    return subscribeGlowPointer();
  }, [disableGlow]);

  const { base, spread } = glowColorMap[glowColor];

  const getSizeClasses = () => {
    if (customSize) {
      return ''; // Let className or inline styles handle sizing
    }
    return sizeMap[size];
  };

  const inlineStyles: React.CSSProperties & Record<string, string | number> = {
    '--base': base,
    '--spread': spread,
  };

  if (width !== undefined) {
    inlineStyles.width = typeof width === 'number' ? `${width}px` : width;
  }
  if (height !== undefined) {
    inlineStyles.height = typeof height === 'number' ? `${height}px` : height;
  }

  // Shared layout classes – overflow-hidden prevents glow pseudo-elements
  // and content from leaking outside the card boundary.
  //
  // Default (fixed-aspect) cards use CSS grid with a growing first row.
  // customSize cards (e.g. Live Dashboard) must NOT — that grid rule stretched
  // the header strip to absorb leftover height, so sparse cards grew tall
  // headers while content-heavy ones stayed thin. Flex + caller-controlled
  // flex-1 on the body keeps headers as thin strips.
  const layoutClasses = `
    glow-card
    ${getSizeClasses()}
    ${!customSize ? 'aspect-[3/4] grid grid-rows-[1fr_auto]' : 'flex flex-col'}
    rounded-2xl
    relative
    overflow-hidden
    shadow-[0_1rem_2rem_-1rem_black]
    p-4
    gap-4
    ${className}
  `;

  if (disableGlow) {
    return (
      <div style={inlineStyles} className={layoutClasses}>
        {children}
      </div>
    );
  }

  return (
    <div data-glow style={inlineStyles} className={layoutClasses}>
      <div data-glow-inner aria-hidden="true" />
      {children}
    </div>
  );
};

export { GlowCard };
