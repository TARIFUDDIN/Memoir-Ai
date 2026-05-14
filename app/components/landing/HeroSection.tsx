'use client'

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Play, Sparkles, ArrowRight } from "lucide-react";
import { useUser, SignUpButton } from "@clerk/nextjs";
import Link from "next/link";

const tabs = [
  { id: "notes", label: "Meeting Notes" },
  { id: "ai", label: "Ask AI" },
  { id: "insights", label: "Insights" },
  { id: "transcripts", label: "Transcripts" },
];

export default function HeroSection() {
  const [active, setActive] = useState("notes");
  const { isSignedIn } = useUser();

  return (
    <section className="relative pt-36 pb-20 overflow-hidden">
      <div className="absolute inset-0 -z-10 opacity-60">
        <div className="absolute left-1/2 top-20 h-[400px] w-[800px] -translate-x-1/2 rounded-full bg-indigo-500/20 blur-[120px]" />
        <div className="absolute right-1/4 top-60 h-[300px] w-[400px] rounded-full bg-cyan-400/15 blur-[100px]" />
      </div>
      <div className="mx-auto max-w-6xl px-4 text-center">
        <div className="animate-fade-up inline-flex items-center gap-2 rounded-full glass px-4 py-1.5 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
          AI-Powered Meeting Assistant
        </div>
        <h1 className="animate-fade-up mt-6 text-4xl font-bold tracking-tight md:text-6xl lg:text-7xl">
          Transform Your Meetings with
          <br />
          <span className="text-gradient">AI Magic</span>
        </h1>
        <p className="animate-fade-up mx-auto mt-6 max-w-2xl text-base text-muted-foreground md:text-lg">
          Automatic summaries, action items, and intelligent insights for every meeting.
          Never miss important details again.
        </p>
        <div className="animate-fade-up mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          {isSignedIn ? (
             <Button asChild size="lg" className="bg-gradient-to-r from-cyan-400 to-indigo-500 text-background hover:opacity-90 glow group cursor-pointer">
               <Link href="/home">
                  Dashboard <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
               </Link>
             </Button>
          ) : (
             <SignUpButton mode="modal">
               <Button size="lg" className="bg-gradient-to-r from-cyan-400 to-indigo-500 text-background hover:opacity-90 glow group cursor-pointer">
                 Start Free Trial <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
               </Button>
             </SignUpButton>
          )}

          <Button size="lg" variant="outline" className="border-white/15 bg-white/5 text-foreground hover:bg-white/10 cursor-pointer">
            <Play className="mr-2 h-4 w-4" />
            Watch Demo
          </Button>
        </div>
        <div className="animate-fade-up mt-6 flex flex-wrap justify-center gap-4 text-sm text-muted-foreground">
            <span>✓ No credit card required</span>
            <span>✓ Setup in 2 minutes</span>
            <span>✓ Free forever plan</span>
        </div>

        <div className="mt-16">
          <div className="inline-flex flex-wrap justify-center gap-1 rounded-full glass p-1.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setActive(t.id)}
                className={`rounded-full px-4 py-2 text-sm transition-all cursor-pointer ${
                  active === t.id
                    ? "bg-gradient-to-r from-cyan-400/90 to-indigo-500/90 text-background"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="relative mx-auto mt-10 max-w-5xl">
            <div className="absolute -inset-4 rounded-3xl bg-gradient-to-r from-cyan-400/20 to-indigo-500/20 blur-2xl" />
            <div className="relative glass-strong rounded-2xl p-2 shadow-2xl">
              <DashboardMock active={active} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DashboardMock({ active }: { active: string }) {
  return (
    <div className="overflow-hidden rounded-xl bg-[oklch(0.12_0.03_265)]">
      <div className="flex items-center gap-1.5 border-b border-white/5 px-4 py-3">
        <div className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
        <div className="h-2.5 w-2.5 rounded-full bg-yellow-400/70" />
        <div className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
        <div className="ml-4 text-xs text-muted-foreground">meetings.ai — {active}</div>
      </div>
      <div className="grid grid-cols-12 min-h-[420px]">
        <aside className="col-span-3 border-r border-white/5 p-4 hidden md:block">
          <div className="text-xs text-muted-foreground mb-3">Recent meetings</div>
          {["Q4 Strategy Sync", "Customer Discovery", "Design Review", "1:1 with Anna"].map((m, i) => (
            <div key={m} className={`mb-2 rounded-lg px-3 py-2 text-sm ${i === 0 ? "bg-white/5 text-foreground" : "text-muted-foreground hover:bg-white/5"}`}>
              {m}
            </div>
          ))}
        </aside>
        <main className="col-span-12 md:col-span-9 p-6 text-left">
          {active === "notes" && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Q4 Strategy Sync — Summary</h3>
              <p className="text-sm text-muted-foreground">42 min • 6 participants • 12 action items</p>
              <ul className="space-y-2 text-sm">
                <li className="rounded-lg glass p-3">→ Align on EMEA expansion timeline by Nov 14</li>
                <li className="rounded-lg glass p-3">→ Anna to draft pricing v2 proposal</li>
                <li className="rounded-lg glass p-3">→ Engineering to scope SSO for enterprise tier</li>
              </ul>
            </div>
          )}
          {active === "ai" && (
            <div className="space-y-3">
              <div className="rounded-2xl glass p-3 text-sm w-fit">What did the client say about pricing two months ago?</div>
              <div className="rounded-2xl bg-gradient-to-br from-cyan-400/15 to-indigo-500/15 border border-white/10 p-3 text-sm max-w-md ml-auto">
                On Sep 12, Acme mentioned a $40k ceiling with annual commit and asked for SSO before signing.
              </div>
            </div>
          )}
          {active === "insights" && (
            <div className="space-y-4">
               <div className="grid grid-cols-2 gap-4">
                  <div className="rounded-lg glass p-4">
                    <div className="text-sm text-muted-foreground mb-1">Talk Time</div>
                    <div className="text-2xl font-semibold text-cyan-300">68%</div>
                  </div>
                  <div className="rounded-lg glass p-4">
                    <div className="text-sm text-muted-foreground mb-1">Sentiment</div>
                    <div className="text-2xl font-semibold text-indigo-400">Positive</div>
                  </div>
               </div>
               <div className="rounded-lg glass p-4 space-y-2">
                 <div className="text-sm font-medium">Key Themes</div>
                 <div className="flex gap-2">
                    <span className="text-xs px-2 py-1 bg-white/5 rounded-full">Expansion</span>
                    <span className="text-xs px-2 py-1 bg-white/5 rounded-full">Pricing Strategy</span>
                    <span className="text-xs px-2 py-1 bg-white/5 rounded-full">Enterprise SSO</span>
                 </div>
               </div>
            </div>
          )}
          {active === "transcripts" && (
            <div className="space-y-2 text-sm font-mono">
              {["00:01 Anna: Welcome everyone, let's start with the roadmap.", "00:14 Marcus: Quick reminder on the security review.", "00:28 Priya: I have the latest user research deck."].map((l) => (
                <div key={l} className="text-muted-foreground">{l}</div>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}