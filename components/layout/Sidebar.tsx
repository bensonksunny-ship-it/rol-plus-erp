"use client";

import Link from "next/link";

export default function Sidebar() {
  return (
    <div className="w-64 h-screen bg-gray-900 text-white p-4">
      <h1 className="text-xl font-bold mb-6">ROL Plus ERP</h1>

      <nav className="flex flex-col gap-4">
        <Link href="/" className="hover:text-gray-300">
          Dashboard
        </Link>

        <Link href="/centers" className="hover:text-gray-300">
          Centers
        </Link>

        <Link href="/students" className="hover:text-gray-300">
          Students
        </Link>

        <Link href="/teachers" className="hover:text-gray-300">
          Teachers
        </Link>
      </nav>
    </div>
  );
}