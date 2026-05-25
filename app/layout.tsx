import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/features/auth/AuthContext";
import ChunkErrorBoundary from "@/components/ChunkErrorBoundary";
import ServiceWorkerRegister from "@/components/pwa/ServiceWorkerRegister";
import InstallPrompt from "@/components/pwa/InstallPrompt";

export const metadata: Metadata = {
  title:       "ROL's Plus",
  description: "River of Life Church ERP — attendance, finance, and more.",
  manifest:    "/manifest.json",
  appleWebApp: {
    capable:         true,
    statusBarStyle:  "black-translucent",
    title:           "ROL's Plus",
  },
  icons: {
    icon:  [
      { url: "/icons/icon-192.png",  sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png",  sizes: "512x512", type: "image/png" },
      { url: "/icons/icon.svg",      type: "image/svg+xml" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width:               "device-width",
  initialScale:        1,
  minimumScale:        1,
  maximumScale:        5,
  viewportFit:         "cover",
  themeColor:          "#0f172a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* PWA splash / status bar */}
        <meta name="apple-mobile-web-app-capable"          content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title"            content="ROL's Plus" />

        {/* Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ChunkErrorBoundary>
          <AuthProvider>{children}</AuthProvider>
        </ChunkErrorBoundary>

        {/* PWA — registered in production only, no-op in dev */}
        <ServiceWorkerRegister />
        <InstallPrompt />
      </body>
    </html>
  );
}
