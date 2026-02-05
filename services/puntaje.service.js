import { Cliente, Credito, Cuota } from '../models/associations.js';
import { differenceInDays, parseISO, isValid } from 'date-fns';

const safeParseISO = (v) => {
    if (v === null || v === undefined) return null;

    // Si ya es Date
    if (v instanceof Date) return isValid(v) ? v : null;

    const s = String(v).trim();
    if (!s) return null;

    try {
        const d = parseISO(s);
        return isValid(d) ? d : null;
    } catch {
        return null;
    }
};

export const calcularPuntajeCliente = async (clienteId) => {
    const cliente = await Cliente.findByPk(clienteId);
    if (!cliente) throw new Error('Cliente no encontrado');

    let puntaje = 0;

    // 🗓️ Antigüedad (si no hay fecha_registro válida, no suma ni resta)
    const fechaRegistro = safeParseISO(cliente.fecha_registro);
    if (fechaRegistro) {
        const diasAntiguedad = differenceInDays(new Date(), fechaRegistro);
        if (diasAntiguedad >= 365) puntaje += 5;
    }

    // 📄 Traer créditos y cuotas
    const creditos = await Credito.findAll({
        where: { cliente_id: clienteId },
        include: [{ model: Cuota, as: 'cuotas' }]
    });

    let totalDevuelto = 0;
    let tieneCreditoVigenteSinMora = false;
    let tieneCreditoConMora = false;

    for (const credito of creditos) {
        let cuotasVencidas = 0;

        // Seguridad: por si viene null/undefined
        const cuotas = Array.isArray(credito?.cuotas) ? credito.cuotas : [];

        for (const cuota of cuotas) {
            const vencimiento = safeParseISO(cuota.fecha_vencimiento);

            if (cuota.estado === 'pagada') {
                // usamos updatedAt como referencia de pago; si no existe usamos "ahora"
                const fechaPago = safeParseISO(cuota.updatedAt) || safeParseISO(cuota.fecha_vencimiento) || new Date();

                // Si no hay vencimiento válido, no evaluamos “a tiempo/tarde”
                if (vencimiento) {
                    if (differenceInDays(fechaPago, vencimiento) <= 0) {
                        puntaje += 10;
                    } else {
                        puntaje -= 5;
                    }
                }

                const pagado = Number(cuota.monto_pagado_acumulado);
                if (Number.isFinite(pagado)) totalDevuelto += pagado;
            }

            if (cuota.estado === 'vencida') {
                cuotasVencidas++;
                puntaje -= 15;
            }
        }

        if (credito.estado === 'pendiente' && cuotasVencidas === 0) {
            tieneCreditoVigenteSinMora = true;
        }

        if (credito.estado === 'vencido') {
            tieneCreditoConMora = true;
        }
    }

    // ✔️ Crédito vigente sin mora
    if (tieneCreditoVigenteSinMora) puntaje += 10;

    // ❌ Crédito con mora
    if (tieneCreditoConMora) puntaje -= 30;

    // 💵 Total devuelto mayor a $100.000
    if (totalDevuelto >= 100000) puntaje += 10;

    // 🚨 Aseguramos que esté entre 0 y 100
    puntaje = Math.max(0, Math.min(puntaje, 100));

    // 📝 Guardamos
    await Cliente.update(
        { puntaje_crediticio: puntaje },
        { where: { id: clienteId } }
    );

    return puntaje;
};