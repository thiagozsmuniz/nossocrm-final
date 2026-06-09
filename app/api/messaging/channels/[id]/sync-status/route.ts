import { createClient } from '@/lib/supabase/server';
import { isAllowedOrigin } from '@/lib/security/sameOrigin';
import { ChannelProviderFactory } from '@/lib/messaging';

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/messaging/channels/[id]/sync-status
 *
 * Consulta o status real da instância no provedor (ex: Evolution API) e
 * atualiza o banco de dados. Resolve o caso em que a instância já está
 * conectada no provedor mas o CRM exibe "Conectando..." porque nenhum
 * webhook foi recebido.
 */
export async function POST(req: Request, { params }: RouteParams) {
  if (!isAllowedOrigin(req)) {
    return json({ error: 'Forbidden' }, 403);
  }

  const { id: channelId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, role, organization_id')
    .eq('id', user.id)
    .single();

  if (profileError || !profile?.organization_id) {
    return json({ error: 'Profile not found' }, 404);
  }

  if (profile.role !== 'admin') {
    return json({ error: 'Forbidden - Admin access required' }, 403);
  }

  const { data: channel, error: channelError } = await supabase
    .from('messaging_channels')
    .select('id, channel_type, provider, external_identifier, credentials, status')
    .eq('id', channelId)
    .eq('organization_id', profile.organization_id)
    .is('deleted_at', null)
    .single();

  if (channelError || !channel) {
    return json({ error: 'Channel not found' }, 404);
  }

  try {
    const provider = ChannelProviderFactory.createProvider(
      channel.channel_type as 'whatsapp' | 'email' | 'instagram',
      channel.provider
    );

    await provider.initialize({
      channelId: channel.id,
      channelType: channel.channel_type as 'whatsapp' | 'email' | 'instagram',
      provider: channel.provider,
      externalIdentifier: channel.external_identifier,
      credentials: channel.credentials as Record<string, string>,
    });

    const statusResult = await provider.getStatus();

    // Map provider status to channel status
    const channelStatus =
      statusResult.status === 'connected' ? 'connected' :
      statusResult.status === 'connecting' ? 'connecting' :
      statusResult.status === 'error' ? 'error' :
      'disconnected';

    await supabase
      .from('messaging_channels')
      .update({
        status: channelStatus,
        status_message: statusResult.message ?? null,
        last_connected_at:
          channelStatus === 'connected' ? new Date().toISOString() : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq('id', channelId);

    return json({ status: channelStatus, message: statusResult.message });
  } catch (error) {
    console.error('[sync-status] Error checking provider status:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to check status' },
      500
    );
  }
}
