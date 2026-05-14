'use client'

import { Users, ServerCrash, Timer, Clock } from "lucide-react";

const stats = [
  { icon: Users, value: "2+", label: "Happy Users" },
  { icon: ServerCrash, value: "99.69%", label: "Uptime" },
  { icon: Timer, value: "2min", label: "Setup Time" },
  { icon: Clock, value: "50hrs", label: "Saved Per Month" },
];

export default function StatsSection() {
  return (
    <section className="py-16">
      <div className="mx-auto max-w-6xl px-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {stats.map((stat) => (
            <div key={stat.label} className="glass-strong rounded-2xl p-6 text-center transition-transform hover:-translate-y-1">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/5 mb-4 text-cyan-300">
                <stat.icon className="w-6 h-6" />
              </div>
              <div className="text-3xl font-bold tracking-tight text-white mb-1">{stat.value}</div>
              <div className="text-sm text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}