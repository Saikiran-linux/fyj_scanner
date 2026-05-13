import './globals.css';
import Nav from '../components/Nav';

export const metadata = {
  title: 'fyj_scanner status',
  description: 'SLA and recent-run dashboard for fyj_scanner.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 min-h-screen">
        <Nav />
        {children}
      </body>
    </html>
  );
}
