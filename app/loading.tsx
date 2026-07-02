export default function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-black via-slate-950 to-black">
      <div className="flex flex-col items-center gap-6">
        <div className="relative">
          <div className="animate-spin h-14 w-14 border-4 border-purple-500/20 border-t-purple-500 rounded-full" />
        </div>
        <p className="font-display text-slate-400 text-sm tracking-widest uppercase">Loading GaiaLog</p>
      </div>
    </div>
  )
}
