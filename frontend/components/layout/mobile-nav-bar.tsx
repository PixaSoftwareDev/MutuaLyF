"use client";

import { Menu } from "lucide-react";
import Image from "next/image";
import { useUIStore } from "@/lib/store";

export function MobileNavBar() {
  const { openMobileSidebar } = useUIStore();

  return (
    <header className="lg:hidden flex items-center gap-3 h-14 px-4 border-b bg-brand text-white shrink-0">
      <button
        onClick={openMobileSidebar}
        className="flex items-center justify-center w-8 h-8 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors"
        aria-label="Abrir menú"
      >
        <Menu className="h-5 w-5" />
      </button>
      <div className="flex items-center gap-2">
        <Image
          src="/Logo.png"
          alt="MutualBot"
          width={24}
          height={24}
          className="w-6 h-6 object-cover rounded-sm"
          priority
          unoptimized
        />
        <span className="font-semibold text-sm tracking-tight">MutualBot</span>
      </div>
    </header>
  );
}
