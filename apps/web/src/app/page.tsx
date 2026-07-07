import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>Cartbox</h1>
      <p>Make and play tiny games. Play free in your browser; keep the revenue on what you sell.</p>
      <p>
        <Link href="/edit/new">Create a Classic cartridge →</Link>
      </p>
      <p>
        <Link href="/edit/new?model=pro">Create a Pro cartridge — 640×360, 64 colors, 8 channels →</Link>
      </p>
      <p>
        <Link href="/edit/new?starter=parallax">Create a parallax scene — three scrolling map layers →</Link>
      </p>
      <p>
        <Link href="/parallax">Open the Parallax Lab — 3D layered scene + segmented character →</Link>
      </p>
      <p>
        <Link href="/browse">Browse cartridges →</Link>
      </p>
    </main>
  );
}
