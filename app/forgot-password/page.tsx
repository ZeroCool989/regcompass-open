import type { Metadata } from 'next';
import { ForgotPasswordForm } from '@/components/ForgotPasswordForm';

export const metadata: Metadata = {
  title: 'Passwort vergessen — RegCompass',
};

export default function ForgotPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-2xl font-heading font-bold tracking-tight">RegCompass</div>
          <p className="text-sm text-text-secondary mt-1">
            Passwort zurücksetzen
          </p>
        </div>
        <div className="rounded-2xl border border-border-brand bg-surface/50 p-6">
          <p className="text-xs text-text-secondary mb-4 leading-relaxed">
            Geben Sie Ihre E-Mail-Adresse ein. Wenn ein Konto existiert, senden wir
            Ihnen einen Link zum Zurücksetzen des Passworts.
          </p>
          <ForgotPasswordForm />
        </div>
      </div>
    </div>
  );
}
