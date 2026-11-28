import { type PortalPoll, mergeVoteResponse } from '@bm/shared/api/polls';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pollsApi } from '@/lib/api/polls';
import { portalKeys, retry, useScope } from './usePortal';

/*
 * Sakin oylamalari (web: hooks/usePolls.ts -> useMyPolls / useMyPoll / useVote). Anahtarlar apartman
 * + kullanici + daire bazlidir (portalKeys altinda; baglam degisince onbellek temizlenir).
 */
export const portalPollKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'polls'] as const,
  list: (apt: string, user: string, unitId?: string) => [...portalPollKeys.all(apt, user), 'list', unitId ?? 'auto'] as const,
  detail: (apt: string, user: string, id: string, unitId?: string) => [...portalPollKeys.all(apt, user), 'detail', id, unitId ?? 'auto'] as const,
};

/** Dairemin katilabildigi oylamalar: acik olanlar once (en yakin bitis), sonra bitenler (API sirasi). */
export function useMyPolls() {
  const { api, apt, userId, unitId, enabled } = useScope();
  return useQuery({
    queryKey: portalPollKeys.list(apt, userId, unitId),
    queryFn: ({ signal }) => pollsApi.list(api, unitId, signal).then((r) => r.items),
    enabled,
    retry,
  });
}

export function useMyPoll(id: string) {
  const { api, apt, userId, unitId, enabled } = useScope();
  return useQuery({
    queryKey: portalPollKeys.detail(apt, userId, id, unitId),
    queryFn: ({ signal }) => pollsApi.get(api, id, unitId, signal),
    enabled: enabled && !!id,
    retry,
  });
}

/**
 * Oy verme / degistirme (web ile ayni: iyimser guncelleme YOK). Basarida yanit ayrintiya yazilir
 * (yanitta sonuc yok: onceki sonuc korunur); her durumda (409 "oylama sona erdi" dahil) liste ve
 * ayrinti yeniden cekilir, ekran guncel durumu gosterir.
 */
export function useVote(id: string) {
  const { api, apt, userId, unitId } = useScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (optionId: string) => pollsApi.vote(api, id, unitId, optionId),
    onSuccess: (poll) => queryClient.setQueryData<PortalPoll>(portalPollKeys.detail(apt, userId, id, unitId), (prev) => mergeVoteResponse(poll, prev)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: portalPollKeys.all(apt, userId) }),
  });
}
