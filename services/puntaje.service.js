import { Cliente, Credito, Cuota } from '../models/associations.js';
import { Op } from 'sequelize';
import { differenceInDays, parseISO } from 'date-fns';

export const calcularPuntajeCliente = async (clienteId) => {
    const cliente = await Cliente.findByPk(clienteId);
    if (!cliente) throw new Error('Cliente no encontrado');

    let puntaje = 0;

    // 🗓️ Antigüedad
    const fechaRegistro = parseISO(cliente.fecha_registro);
    const diasAntiguedad = differenceInDays(new Date(), fechaRegistro);
    if (diasAntiguedad >= 365) {
        puntaje += 5;
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
        let cuotasPagadasATiempo = 0;
        let cuotasPagadasTarde = 0;

        for (const cuota of credito.cuotas) {
            const vencimiento = parseISO(cuota.fecha_vencimiento);

            if (cuota.estado === 'pagada') {
                const fechaPago = new Date(cuota.updatedAt || cuota.fecha_vencimiento); // usamos updatedAt como referencia de pago
                if (differenceInDays(fechaPago, vencimiento) <= 0) {
                    cuotasPagadasATiempo++;
                    puntaje += 10;
                } else {
                    cuotasPagadasTarde++;
                    puntaje -= 5;
                }

                totalDevuelto += parseFloat(cuota.monto_pagado_acumulado);
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
    if (tieneCreditoVigenteSinMora) {
        puntaje += 10;
    }

    // ❌ Crédito con mora
    if (tieneCreditoConMora) {
        puntaje -= 30;
    }

    // 💵 Total devuelto mayor a $100.000
    if (totalDevuelto >= 100000) {
        puntaje += 10;
    }

    // 🚨 Aseguramos que esté entre 0 y 100
    puntaje = Math.max(0, Math.min(puntaje, 100));

    // 📝 Guardamos
    await Cliente.update(
        { puntaje_crediticio: puntaje },
        { where: { id: clienteId } }
    );

    return puntaje;
};
