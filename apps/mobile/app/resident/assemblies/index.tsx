import { Stack } from 'expo-router';
import { AssembliesScreen } from '@/screens/resident/AssembliesScreen';

/** Genel Kurul yalnizca maliklere (kiracida ekran "kat maliklerine açıktır" der; API de 403). */
export default function AssembliesRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Genel Kurul' }} />
      <AssembliesScreen />
    </>
  );
}
