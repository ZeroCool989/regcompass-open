/**
 * German Cartesia (sonic-3) voices offered in the Aegis "Vorlesen" picker.
 *
 * Single source of truth shared by the client picker (AegisVoicePicker) and the
 * server synth route (/api/aegis/tts) — the route validates the requested voice
 * id against this allowlist so the endpoint can't be used to proxy arbitrary
 * Cartesia voices. IDs are from the Cartesia voice library (language=de).
 *
 * Residency: Cartesia is third-party/cloud — fine for the internal demo, must
 * move in-infra before real client data (see services/voice-gateway).
 */

export type CartesiaGender = 'feminine' | 'masculine';

export interface CartesiaVoice {
  id: string;
  /** Display name shown in the picker. */
  name: string;
  gender: CartesiaGender;
}

/** Sebastian (Orator) — the default Cartesia voice when none is otherwise
 *  specified. Masculine German, fitting the advisory tone (and "der Schild"). */
export const DEFAULT_CARTESIA_VOICE_ID = 'b7187e84-fe22-4344-ba4a-bc013fcb533e';

export const CARTESIA_GERMAN_VOICES: CartesiaVoice[] = [
  { id: '9b4d08b6-0494-4301-ab92-9150f4ee2718', name: 'Marlene', gender: 'feminine' },
  { id: '38aabb6a-f52b-4fb0-a3d1-988518f4dc06', name: 'Alina', gender: 'feminine' },
  { id: 'b9de4a89-2257-424b-94c2-db18ba68c81a', name: 'Viktoria', gender: 'feminine' },
  { id: '4ab1ff51-476d-42bb-8019-4d315f7c0c05', name: 'Lena', gender: 'feminine' },
  { id: '3f4ade23-6eb4-4279-ab05-6a144947c4d5', name: 'Karin', gender: 'feminine' },
  { id: '1ade29fc-6b82-4607-9e70-361720139b12', name: 'Lea', gender: 'feminine' },
  { id: '2578354e-4b18-4d28-832c-5943344b7085', name: 'Klara', gender: 'feminine' },
  { id: 'c0c52199-e35f-4681-b68a-949ee499617e', name: 'Eleni', gender: 'feminine' },
  { id: 'ac197a78-cec7-4c50-93e5-93bdc1910b11', name: 'Jennifer', gender: 'feminine' },
  { id: 'de07efe3-b309-418b-bdca-42827223efd2', name: 'Rena', gender: 'feminine' },
  { id: '43a317e9-f1b9-45bf-bbdb-1d4a52e46f0d', name: 'Emi', gender: 'feminine' },
  { id: 'b629d743-2b5a-4ffd-b5bb-9de9b969a690', name: 'Sibylle', gender: 'feminine' },
  { id: '40e0f496-a220-46bb-975a-7ef465b3d92b', name: 'Vreni', gender: 'feminine' },
  { id: 'adc919b3-6ebf-47fd-8a46-27c5169d6d94', name: 'Leni', gender: 'feminine' },
  { id: '0b66a153-548f-4f2c-b734-09a13b0bd163', name: 'Lorelei', gender: 'feminine' },
  { id: '6d4b1416-8d54-4d94-a788-8a802c086544', name: 'Sabine', gender: 'feminine' },
  { id: 'b7187e84-fe22-4344-ba4a-bc013fcb533e', name: 'Sebastian', gender: 'masculine' },
  { id: '4ad22058-7cb6-402c-a115-196cbfc25dce', name: 'Moritz', gender: 'masculine' },
  { id: 'd1cbea67-e4d3-47cd-be2a-2bd4e646b002', name: 'Henrik', gender: 'masculine' },
  { id: 'e00dd3df-19e7-4cd4-827a-7ff6687b6954', name: 'Lukas', gender: 'masculine' },
  { id: 'afa425cf-5489-4a09-8a3f-d3cb1f82150d', name: 'Nico', gender: 'masculine' },
  { id: 'db229dfe-f5de-4be4-91fd-7b077c158578', name: 'Andreas', gender: 'masculine' },
  { id: 'cd7b67f4-22a4-49a0-a197-3fa16f7e64d4', name: 'Felix', gender: 'masculine' },
  { id: 'f6f315e4-4fb3-4440-92ea-2edb01f9bf1b', name: 'Hermann', gender: 'masculine' },
  { id: '42f14755-88c3-4124-aae3-5cc3a9618e8f', name: 'Jan', gender: 'masculine' },
  { id: '3264ada2-4a79-4666-badc-49e2267be692', name: 'Christian', gender: 'masculine' },
  { id: '758a5cff-af0b-4bdf-84bd-4c1b5525c249', name: 'Leander', gender: 'masculine' },
  { id: 'dff81230-ff75-49a4-af44-f6b2f43500d8', name: 'Jonas', gender: 'masculine' },
  { id: 'd42fc8d7-efdd-44df-bb2e-a6e093601917', name: 'Oskar', gender: 'masculine' },
  { id: '24c61c42-b538-468e-a9ad-16c7a032c9cb', name: 'Klaus', gender: 'masculine' },
  { id: '2be00b67-d53f-4eb5-89e7-96c224d56fbc', name: 'Dieter', gender: 'masculine' },
  { id: '384b625b-da5d-49e8-a76d-a2855d4f31eb', name: 'Thomas', gender: 'masculine' },
];

const VOICE_IDS = new Set(CARTESIA_GERMAN_VOICES.map((v) => v.id));

export function isKnownCartesiaVoice(id: string): boolean {
  return VOICE_IDS.has(id);
}
