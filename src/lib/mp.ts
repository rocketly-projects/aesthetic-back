/**
 * MercadoPago helpers para señas/depósitos.
 * Usa el access_token OAuth del negocio (no el token de plataforma).
 */

export interface MpPreferenceInput {
  businessId:    string
  appointmentId: string
  serviceName:   string
  price:         number        // precio total del servicio (en pesos)
  depositPercent: number       // ej. 30
  mpAccessToken: string        // token OAuth del negocio
  frontendUrl:   string        // para back_urls
  backendUrl:    string        // para notification_url
}

export interface MpPreferenceResult {
  preferenceId: string
  initPoint:    string
  depositAmount: number
}

export async function createMpPreference(
  input: MpPreferenceInput
): Promise<MpPreferenceResult> {
  const depositAmount = Math.round((input.price * input.depositPercent) / 100)
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 min

  const body = {
    items: [
      {
        id:          input.appointmentId,
        title:       `Seña – ${input.serviceName}`,
        quantity:    1,
        unit_price:  depositAmount,
        currency_id: 'ARS',
      },
    ],
    back_urls: {
      success: `${input.frontendUrl}/reserva/confirmada`,
      failure: `${input.frontendUrl}/reserva/fallida`,
      pending: `${input.frontendUrl}/reserva/pendiente`,
    },
    auto_return:          'approved',
    notification_url:     `${input.backendUrl}/billing/deposit-webhook`,
    external_reference:   input.appointmentId,
    expiration_date_from: new Date().toISOString(),
    expiration_date_to:   expiresAt,
  }

  const res = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      Authorization:   `Bearer ${input.mpAccessToken}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`MP preference error: ${res.status} — ${err}`)
  }

  const data = await res.json() as { id: string; init_point: string }

  return {
    preferenceId:  data.id,
    initPoint:     data.init_point,
    depositAmount,
  }
}
