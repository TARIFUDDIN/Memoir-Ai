'use client'

import { ArrowRight, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useUser, SignUpButton } from "@clerk/nextjs";

export default function CTASection() {
  const { isSignedIn } = useUser();

  return (
    <section className="py-32 relative overflow-hidden">
      <div className="absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/2 h-[500px] w-[900px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-r from-cyan-400/20 to-indigo-500/25 blur-[120px]" />
      </div>
      <div className="mx-auto max-w-4xl px-4 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full glass px-4 py-1.5 text-xs font-medium text-amber-200">
           <div className="flex">
             {[...Array(5)].map((_, i) => (
                <Star key={i} className="h-3.5 w-3.5 fill-current" />
             ))}
           </div>
           4.9/5 from 2+ reviews
        </div>
        
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight">
          Ready to revolutionize <br />
          <span className="text-gradient">your meetings?</span>
        </h2>
        <p className="mt-6 text-muted-foreground max-w-xl mx-auto text-lg">
          Join thousands of teams already using MeetingBot to save time.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
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
        </div>
      </div>
    </section>
  );
}