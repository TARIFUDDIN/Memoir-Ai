'use client'

import { Sparkles, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SignInButton, SignUpButton, useUser } from "@clerk/nextjs";
import Link from "next/link";

export function Navbar() {
  const { isSignedIn } = useUser();
  return (
    <header className="fixed top-0 inset-x-0 z-50">
      <div className="mx-auto mt-4 max-w-6xl px-4">
        <nav className="glass-strong flex items-center justify-between rounded-2xl px-5 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-cyan-400 to-indigo-500 text-background">
              <Bot className="h-5 w-5" />
            </span>
            <span className="text-foreground">Meetings AI</span>
          </Link>
          <ul className="hidden items-center gap-7 md:flex">
             <li>
                 <Link href="/research" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
                     Research
                 </Link>
             </li>
          </ul>
          <div className="flex items-center gap-2">
            {isSignedIn ? (
                <Button asChild size="sm" className="bg-gradient-to-r from-cyan-400 to-indigo-500 text-background hover:opacity-90">
                    <Link href="/home">Dashboard</Link>
                </Button>
            ) : (
                <>
                    <SignInButton mode="modal">
                        <Button variant="ghost" size="sm" className="hidden sm:inline-flex text-foreground hover:bg-white/5 cursor-pointer">
                            Sign In
                        </Button>
                    </SignInButton>
                    <SignUpButton mode="modal">
                        <Button size="sm" className="bg-gradient-to-r from-cyan-400 to-indigo-500 text-background hover:opacity-90 cursor-pointer">
                            Sign Up
                        </Button>
                    </SignUpButton>
                </>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}
