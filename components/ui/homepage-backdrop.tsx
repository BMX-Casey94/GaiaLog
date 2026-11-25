/**
 * Subtle ambient deep-purple gradient & domain-relevant watermark backdrop
 * for the GaiaLog homepage:
 * - Topographic / meridian globe rings (global earth observation)
 * - Telemetry / seismic waveform (live environmental sensors)
 * - Hexagonal node lattice (immutable BSV blockchain verification)
 */
export function HomepageBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none"
    >
      {/* Base deep-purple atmospheric radial glows */}
      <div
        className="absolute inset-0"
        style={{
          background: [
            "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(88, 28, 135, 0.28) 0%, transparent 65%)",
            "radial-gradient(ellipse 60% 45% at 15% 38%, rgba(76, 29, 149, 0.18) 0%, transparent 65%)",
            "radial-gradient(ellipse 65% 45% at 85% 62%, rgba(88, 28, 135, 0.16) 0%, transparent 65%)",
            "radial-gradient(ellipse 70% 40% at 50% 95%, rgba(59, 7, 100, 0.22) 0%, transparent 70%)",
          ].join(", "),
        }}
      />

      {/* Watermark 1: Global meridian / earth-observation rings (top-right) */}
      <svg
        viewBox="0 0 600 600"
        fill="none"
        className="absolute -right-28 top-[18vh] w-[520px] h-[520px] md:w-[680px] md:h-[680px] opacity-[0.06] text-purple-300"
      >
        <circle cx="300" cy="300" r="240" stroke="currentColor" strokeWidth="1" />
        <circle cx="300" cy="300" r="185" stroke="currentColor" strokeWidth="0.75" strokeDasharray="4 6" />
        <circle cx="300" cy="300" r="130" stroke="currentColor" strokeWidth="0.75" />
        <ellipse cx="300" cy="300" rx="240" ry="88" stroke="currentColor" strokeWidth="0.75" />
        <ellipse cx="300" cy="300" rx="240" ry="165" stroke="currentColor" strokeWidth="0.6" strokeDasharray="3 7" />
        <ellipse cx="300" cy="300" rx="88" ry="240" stroke="currentColor" strokeWidth="0.75" />
        <ellipse cx="300" cy="300" rx="165" ry="240" stroke="currentColor" strokeWidth="0.6" />
        <line x1="60" y1="300" x2="540" y2="300" stroke="currentColor" strokeWidth="0.6" />
        <line x1="300" y1="60" x2="300" y2="540" stroke="currentColor" strokeWidth="0.6" />
        {/* Sensor nodes on the globe */}
        <circle cx="212" cy="186" r="4" fill="currentColor" />
        <circle cx="396" cy="242" r="3.5" fill="currentColor" />
        <circle cx="268" cy="378" r="4" fill="currentColor" />
        <circle cx="420" cy="348" r="3" fill="currentColor" />
      </svg>

      {/* Watermark 2: Blockchain hexagonal lattice (mid-left) */}
      <svg
        viewBox="0 0 480 480"
        fill="none"
        className="absolute -left-24 top-[48vh] w-[420px] h-[420px] md:w-[540px] md:h-[540px] opacity-[0.055] text-violet-300"
      >
        <g stroke="currentColor" strokeWidth="0.9">
          <polygon points="140,70 192,100 192,160 140,190 88,160 88,100" />
          <polygon points="244,70 296,100 296,160 244,190 192,160 192,100" />
          <polygon points="192,160 244,190 244,250 192,280 140,250 140,190" />
          <polygon points="296,160 348,190 348,250 296,280 244,250 244,190" />
          <polygon points="140,250 192,280 192,340 140,370 88,340 88,280" />
          <polygon points="244,250 296,280 296,340 244,370 192,340 192,280" />
        </g>
        <g fill="currentColor">
          <circle cx="192" cy="160" r="3.5" />
          <circle cx="244" cy="190" r="3.5" />
          <circle cx="192" cy="280" r="3.5" />
          <circle cx="244" cy="250" r="3" />
          <circle cx="140" cy="190" r="3" />
        </g>
      </svg>

      {/* Watermark 3: Environmental / seismic telemetry waveform (bottom) */}
      <svg
        viewBox="0 0 1200 160"
        fill="none"
        preserveAspectRatio="none"
        className="absolute bottom-8 left-0 w-full h-32 opacity-[0.06] text-purple-300"
      >
        <path
          d="M0 90 L140 90 L165 78 L185 104 L210 52 L232 126 L256 34 L278 134 L302 74 L326 96 L350 90 L520 90 L548 82 L568 102 L592 62 L614 118 L638 46 L660 122 L686 80 L710 92 L890 90 L918 76 L940 110 L966 42 L990 128 L1016 68 L1042 96 L1068 90 L1200 90"
          stroke="currentColor"
          strokeWidth="1.25"
        />
        <line x1="0" y1="90" x2="1200" y2="90" stroke="currentColor" strokeWidth="0.5" strokeDasharray="4 8" />
      </svg>
    </div>
  )
}
