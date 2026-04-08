import "./globals.css";
import { AuthProvider } from "@/features/auth/AuthContext";
import ChunkErrorBoundary from "@/components/ChunkErrorBoundary";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
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
      </body>
    </html>
  );
}
