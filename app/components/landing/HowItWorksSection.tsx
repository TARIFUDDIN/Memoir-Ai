'use client'

import { CalendarCheck, Bot, Sparkles } from "lucide-react";

const steps = [
  {
    icon: CalendarCheck,
    title: "Connect Calendar",
    description: "Link your Google Calendar and we'll automatically detect your meetings"
  },
  {
    icon: Bot,
    title: "Bot Joins Meeting",
    description: "Our AI bot automatically joins and records your meetings with full transcription"
  },
  {
    icon: Sparkles,
    title: "Get Insights",
    description: "Receive summaries, action items, and push them to your favourite tools instantly"
  }
];

export default function HowItWorksSection() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-6xl px-4">
        <div className="text-center">
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight">
            How It <span className="text-gradient">Works</span>
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            Get Started in minutes with our simple 3-step-process
          </p>
        </div>

        <div className="mt-16 grid md:grid-cols-3 gap-8 relative">
          <div className="hidden md:block absolute top-1/2 left-[10%] right-[10%] h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-y-1/2 z-0" />
          
          {steps.map((step, index) => (
            <div key={step.title} className="relative z-10 flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-full glass-strong flex items-center justify-center mb-6 shadow-xl relative">
                <div className="absolute -inset-2 bg-gradient-to-r from-cyan-400/20 to-indigo-500/20 rounded-full blur-md opacity-0 group-hover:opacity-100 transition-opacity" />
                <step.icon className="w-7 h-7 text-cyan-300 relative z-10" />
                <div className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-gradient-to-r from-cyan-400 to-indigo-500 flex items-center justify-center text-[10px] font-bold text-background shadow-lg">
                  {index + 1}
                </div>
              </div>
              <h3 className="text-xl font-semibold mb-3">{step.title}</h3>
              <p className="text-muted-foreground">{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}