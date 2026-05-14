import { Navbar } from "./components/landing/Navbar";
import HeroSection from "./components/landing/HeroSection";
import FeaturesSection from "./components/landing/FeaturesSection";
import IntegrationsSection from "./components/landing/IntegrationsSection";
import HowItWorksSection from "./components/landing/HowItWorksSection";
import StatsSection from "./components/landing/StatsSection";
import MoreFeaturesSection from "./components/landing/MoreFeaturesSection";
import CTASection from "./components/landing/CTASection";
import Footer from "./components/landing/Footer";

export default function Home ()
{
  return (
    <div className="min-h-screen bg-background dark selection:bg-cyan-500/30">
      <Navbar />
      <HeroSection />
      <FeaturesSection />
      <IntegrationsSection />
      <HowItWorksSection />
      <StatsSection />
      <MoreFeaturesSection />
      <CTASection />
      <Footer />
    </div>
  );
}