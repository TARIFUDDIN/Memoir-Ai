import { Bot } from "lucide-react";
import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t border-white/5 py-16 mt-20">
      <div className="mx-auto max-w-6xl px-4 flex flex-col items-center">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-cyan-400 to-indigo-500 text-background">
            <Bot className="h-4 w-4" />
          </span>
          Meetings AI
        </Link>
        <p className="mt-4 text-sm text-muted-foreground">Transform Your Meetings with AI Magic.</p>
        <div className="mt-8 flex gap-6 text-sm text-muted-foreground">
          <Link href="#" className="hover:text-foreground">Privacy Policy</Link>
          <Link href="#" className="hover:text-foreground">Terms of Service</Link>
          <Link href="#" className="hover:text-foreground">Support</Link>
        </div>
        <div className="mt-12 text-xs text-muted-foreground">
          © {new Date().getFullYear()} Meetings AI. All rights reserved.
        </div>
      </div>
    </footer>
  );
}