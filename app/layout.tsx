import "./globals.css";
import type { Metadata } from "next";
export const metadata: Metadata = { title:"SignalForge", description:"AI market-intelligence and memecoin alerting terminal" };
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}