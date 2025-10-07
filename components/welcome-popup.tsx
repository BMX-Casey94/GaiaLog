"use client"

import { useEffect, useState } from "react"
import { X, Info } from "lucide-react"

export function WelcomePopup() {
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    // Check if user has seen the popup before
    const hasSeenPopup = localStorage.getItem("gaialog-welcome-popup-seen")
    
    if (!hasSeenPopup) {
      // Small delay for better UX
      setTimeout(() => {
        setIsVisible(true)
      }, 500)
    }
  }, [])

  const handleClose = () => {
    setIsVisible(false)
    localStorage.setItem("gaialog-welcome-popup-seen", "true")
  }

  if (!isVisible) return null

  return (
    <>
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[999] animate-in fade-in duration-300"
        onClick={handleClose}
      />
      
      {/* Popup Modal */}
      <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4 pointer-events-none">
        <div 
          className="relative w-full max-w-lg pointer-events-auto animate-in zoom-in-95 duration-300"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Glass Effect Container */}
          <div className="
            backdrop-blur-[20px] 
            bg-gradient-to-br 
            from-white/15 to-white/5 
            dark:from-white/10 dark:to-white/5 
            border border-white/20 
            dark:border-white/10 
            rounded-2xl 
            shadow-2xl 
            p-6 sm:p-8
            relative
            overflow-hidden
          ">
            {/* Subtle gradient overlay for depth */}
            <div className="absolute inset-0 bg-gradient-to-br from-cyan-400/5 via-transparent to-purple-400/5 pointer-events-none" />
            
            {/* Close button */}
            <button
              onClick={handleClose}
              className="
                absolute top-4 right-4 
                p-2 
                rounded-full 
                bg-white/10 
                hover:bg-white/20 
                border border-white/20 
                transition-all duration-200 
                hover:scale-110
                z-10
              "
              aria-label="Close popup"
            >
              <X className="h-4 w-4 text-white" />
            </button>

            {/* Content */}
            <div className="relative z-10">
              {/* Icon */}
              <div className="
                w-14 h-14 
                mb-5 
                bg-gradient-to-br from-cyan-400/20 to-blue-400/20 
                rounded-full 
                flex items-center justify-center 
                border border-cyan-400/30
              ">
                <Info className="h-7 w-7 text-cyan-400" />
              </div>

              {/* Title */}
              <h2 className="
                text-2xl sm:text-3xl 
                font-bold 
                text-white 
                mb-4
                leading-tight
              ">
                Welcome to GaiaLog
              </h2>

              {/* Message */}
              <p className="
                text-base sm:text-lg 
                text-slate-200 
                dark:text-slate-300 
                leading-relaxed 
                mb-6
              ">
                Our system is currently operating at a reduced capacity while we work with our providers to increase API request limits and carry out additional testing, to help prevent the rate limiting we&apos;re currently experiencing.
              </p>

              {/* Divider */}
              <div className="w-full h-px bg-gradient-to-r from-transparent via-white/20 to-transparent mb-6" />

              {/* Additional info */}
              <p className="
                text-sm 
                text-slate-300 
                dark:text-slate-400 
                mb-6
              ">
                Thank you for your patience as we work to improve our service.
              </p>

              {/* Button */}
              <button
                onClick={handleClose}
                className="
                  w-full 
                  py-3 
                  px-6 
                  bg-gradient-to-r from-cyan-500 to-blue-500 
                  hover:from-cyan-600 hover:to-blue-600 
                  text-white 
                  font-semibold 
                  rounded-xl 
                  transition-all duration-200 
                  hover:scale-[1.02]
                  shadow-lg 
                  shadow-cyan-500/25
                "
              >
                I Understand
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

