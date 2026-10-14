import { useEffect, useState } from "react";

import { stopVoiceCall, useVoiceCall } from "@/lib/voice-call";
import { cn } from "@/lib/utils";

// A bolinha da call de voz (patch local): flutua no canto enquanto a call existe, pulsa quando está
// ao vivo, e um toque encerra. Não cobre nada além dela mesma, para o chat continuar legível.
export function VoiceBubble() {
  const call = useVoiceCall();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (call.phase !== "idle" || call.error === undefined) return;
    setError(call.error);
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [call]);

  if (call.phase === "idle") {
    if (error === null) return null;
    return (
      <div className="fixed bottom-36 right-3 z-50 max-w-60 rounded-lg bg-status-blocked px-3 py-2 text-xs text-white shadow-lg">
        Call: {error}
      </div>
    );
  }

  const live = call.phase === "live";
  return (
    <button
      type="button"
      onClick={stopVoiceCall}
      aria-label={live ? "Call ao vivo. Toque para encerrar" : "Conectando a call. Toque para cancelar"}
      className="fixed bottom-36 right-3 z-50 flex size-10 items-center justify-center rounded-full shadow-lg"
    >
      <span
        className={cn(
          "absolute inset-0 rounded-full opacity-60",
          live ? "animate-ping bg-red-500" : "bg-amber-400",
        )}
      />
      <span className={cn("relative size-5 rounded-full", live ? "bg-red-600" : "animate-pulse bg-amber-500")} />
    </button>
  );
}
