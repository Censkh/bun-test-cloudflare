import { connection } from "next/server";
import { Suspense } from "react";

async function RuntimeContent() {
  await connection();

  return <main>OpenNext Cache Components rendered successfully</main>;
}

export default function CachedPage() {
  return (
    <Suspense fallback={<main>Loading...</main>}>
      <RuntimeContent />
    </Suspense>
  );
}
