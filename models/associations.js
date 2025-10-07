// backend/src/models/associations.js
import Cliente from './Cliente.js';
import Credito from './Credito.js';
import Cuota from './Cuota.js';
import Pago from './Pago.js';
import Usuario from './Usuario.js';
import FormaPago from './FormaPago.js';
import TareaPendiente from './Tarea_pendiente.js';
import Zona from './Zona.js';
import Recibo from './Recibo.js';
import CajaMovimiento from './CajaMovimiento.js'; // ⬅️ Caja
import Compra from './Compra.js';                 // ⬅️ Compras
import VentaManual from './VentaManual.js';       // ⬅️ Ventas manuales
import Gasto from './Gasto.js';                   // ⬅️ Gastos
import Proveedor from './Proveedor.js';           // ⬅️ Proveedores

/* ───────── Relaciones base (con guards) ───────── */

if (!Pago.associations?.cuota) {
    Pago.belongsTo(Cuota, { as: 'cuota', foreignKey: 'cuota_id' });
}
if (!Cuota.associations?.pagos) {
    Cuota.hasMany(Pago, { as: 'pagos', foreignKey: 'cuota_id' });
}

if (!Cliente.associations?.creditos) {
    Cliente.hasMany(Credito, { as: 'creditos', foreignKey: 'cliente_id' });
}
if (!Credito.associations?.cliente) {
    Credito.belongsTo(Cliente, { as: 'cliente', foreignKey: 'cliente_id' });
}

if (!Credito.associations?.cuotas) {
    Credito.hasMany(Cuota, { as: 'cuotas', foreignKey: 'credito_id' });
}
if (!Cuota.associations?.credito) {
    Cuota.belongsTo(Credito, { as: 'credito', foreignKey: 'credito_id' });
}

if (!Credito.associations?.cobradorCredito) {
    Credito.belongsTo(Usuario, { as: 'cobradorCredito', foreignKey: 'cobrador_id' });
}
if (!Usuario.associations?.creditosCobrados) {
    Usuario.hasMany(Credito, { as: 'creditosCobrados', foreignKey: 'cobrador_id' });
}

if (!Pago.associations?.formaPago) {
    Pago.belongsTo(FormaPago, { as: 'formaPago', foreignKey: 'forma_pago_id' });
}
if (!FormaPago.associations?.pagos) {
    FormaPago.hasMany(Pago, { as: 'pagos', foreignKey: 'forma_pago_id' });
}

// Relación Pago-Recibo
if (!Pago.associations?.recibo) {
    Pago.hasOne(Recibo, { foreignKey: 'pago_id', as: 'recibo' });
}
if (!Recibo.associations?.pago) {
    Recibo.belongsTo(Pago, { foreignKey: 'pago_id', as: 'pago' });
}

// Relación Cuota-Recibos
if (!Cuota.associations?.recibos) {
    Cuota.hasMany(Recibo, { foreignKey: 'cuota_id', as: 'recibos' });
}
if (!Recibo.associations?.cuota) {
    Recibo.belongsTo(Cuota, { foreignKey: 'cuota_id', as: 'cuota' });
}

if (!TareaPendiente.associations?.creador) {
    TareaPendiente.belongsTo(Usuario, {
        foreignKey: { name: 'creadoPor', allowNull: true },
        as: 'creador'
    });
}

if (!Cliente.associations?.cobradorUsuario) {
    Cliente.belongsTo(Usuario, { foreignKey: 'cobrador', as: 'cobradorUsuario' });
}
if (!Cliente.associations?.clienteZona) {
    Cliente.belongsTo(Zona, { foreignKey: 'zona', as: 'clienteZona' });
}

/* ───────── Compra ───────── */
if (!Compra.associations?.formaPago) {
    Compra.belongsTo(FormaPago, { foreignKey: 'forma_pago_id', as: 'formaPago' });
}
if (!FormaPago.associations?.compras) {
    FormaPago.hasMany(Compra, { foreignKey: 'forma_pago_id', as: 'compras' });
}
if (!Compra.associations?.cajaMovimiento) {
    Compra.belongsTo(CajaMovimiento, { foreignKey: 'caja_movimiento_id', as: 'cajaMovimiento' });
}
if (!Compra.associations?.usuario) {
    Compra.belongsTo(Usuario, { foreignKey: 'usuario_id', as: 'usuario' });
}
if (!Usuario.associations?.comprasCargadas) {
    Usuario.hasMany(Compra, { foreignKey: 'usuario_id', as: 'comprasCargadas' });
}
/* ✅ NUEVO: Compra ⇄ Proveedor */
if (!Compra.associations?.proveedor) {
    Compra.belongsTo(Proveedor, { foreignKey: 'proveedor_id', as: 'proveedor' });
}
if (!Proveedor.associations?.compras) {
    Proveedor.hasMany(Compra, { foreignKey: 'proveedor_id', as: 'compras' });
}

/* ───────── VentaManual ───────── */
if (!VentaManual.associations?.formaPago) {
    VentaManual.belongsTo(FormaPago, { foreignKey: 'forma_pago_id', as: 'formaPago' });
}
if (!FormaPago.associations?.ventasManuales) {
    FormaPago.hasMany(VentaManual, { foreignKey: 'forma_pago_id', as: 'ventasManuales' });
}
if (!VentaManual.associations?.cajaMovimiento) {
    VentaManual.belongsTo(CajaMovimiento, { foreignKey: 'caja_movimiento_id', as: 'cajaMovimiento' });
}
if (!VentaManual.associations?.usuario) {
    VentaManual.belongsTo(Usuario, { foreignKey: 'usuario_id', as: 'usuario' });
}
if (!Usuario.associations?.ventasCargadas) {
    Usuario.hasMany(VentaManual, { foreignKey: 'usuario_id', as: 'ventasCargadas' });
}

/* ✅ VentaManual ⇄ Cliente */
if (!VentaManual.associations?.cliente) {
    VentaManual.belongsTo(Cliente, { foreignKey: 'cliente_id', as: 'cliente' });
}
if (!Cliente.associations?.ventasManuales) {
    Cliente.hasMany(VentaManual, { foreignKey: 'cliente_id', as: 'ventasManuales' });
}

/* ✅ VentaManual ⇄ Crédito (origen del crédito desde venta) */
if (!VentaManual.associations?.credito) {
    VentaManual.belongsTo(Credito, { foreignKey: 'credito_id', as: 'credito' });
}
if (!Credito.associations?.ventaOrigen) {
    Credito.hasOne(VentaManual, { foreignKey: 'credito_id', as: 'ventaOrigen' });
}

/* ───────── Gasto ───────── */
if (!Gasto.associations?.formaPago) {
    Gasto.belongsTo(FormaPago, { foreignKey: 'forma_pago_id', as: 'formaPago' });
}
if (!FormaPago.associations?.gastos) {
    FormaPago.hasMany(Gasto, { foreignKey: 'forma_pago_id', as: 'gastos' });
}
if (!Gasto.associations?.cajaMovimiento) {
    Gasto.belongsTo(CajaMovimiento, { foreignKey: 'caja_movimiento_id', as: 'cajaMovimiento' });
}
if (!Gasto.associations?.usuario) {
    Gasto.belongsTo(Usuario, { foreignKey: 'usuario_id', as: 'usuario' });
}
if (!Usuario.associations?.gastosCargados) {
    Usuario.hasMany(Gasto, { foreignKey: 'usuario_id', as: 'gastosCargados' });
}

/* ✅ Gasto ⇄ Proveedor */
if (!Gasto.associations?.proveedor) {
    Gasto.belongsTo(Proveedor, { foreignKey: 'proveedor_id', as: 'proveedor' });
}
if (!Proveedor.associations?.gastos) {
    Proveedor.hasMany(Gasto, { foreignKey: 'proveedor_id', as: 'gastos' });
}

/* ───────── CajaMovimiento (guards) ───────── */
if (!CajaMovimiento.associations?.formaPago) {
    CajaMovimiento.belongsTo(FormaPago, { foreignKey: 'forma_pago_id', as: 'formaPago' });
}
if (!FormaPago.associations?.movimientos) {
    FormaPago.hasMany(CajaMovimiento, { foreignKey: 'forma_pago_id', as: 'movimientos' });
}
if (!CajaMovimiento.associations?.usuario) {
    CajaMovimiento.belongsTo(Usuario, { foreignKey: 'usuario_id', as: 'usuario' });
}
if (!Usuario.associations?.movimientosRegistrados) {
    Usuario.hasMany(CajaMovimiento, { foreignKey: 'usuario_id', as: 'movimientosRegistrados' });
}

export {
    Cliente,
    Credito,
    Cuota,
    Pago,
    Usuario,
    FormaPago,
    TareaPendiente,
    Zona,
    Recibo,
    CajaMovimiento,
    Compra,
    VentaManual,
    Gasto,
    Proveedor, // ➕ export
};