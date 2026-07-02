export function AttributionBar({ className = "" }: { className?: string }) {
  return (
    <div className={`text-[10px] leading-relaxed text-slate-500 ${className}`}>
      Environmental data attributions:{" "}
      <a href="https://waqi.info/" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-300 transition-colors">
        World Air Quality Index (WAQI)
      </a>
      {" • "}
      <a href="https://www.weatherapi.com/" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-300 transition-colors">
        WeatherAPI
      </a>
      {" • "}
      <a href="https://api.tidesandcurrents.noaa.gov/" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-300 transition-colors">
        NOAA Tides &amp; Currents
      </a>
      {" • "}
      <a href="https://earthquake.usgs.gov/fdsnws/" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-300 transition-colors">
        USGS Earthquake
      </a>
      . Attribution required by providers; see their terms.
    </div>
  )
}
