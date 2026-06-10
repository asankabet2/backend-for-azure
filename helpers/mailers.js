'use strict';

const nodemailer = require('nodemailer');


const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});


function interpolate(template, data = {}) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? `{{${key}}}`);
}

/**
 * Send an email using a template loaded from the database.
 *
 * @param {object} pool     - The mssql connection pool
 * @param {object} sql      - The mssql sql tag
 * @param {string} typeId   - The EmailTemplateType ID (e.g. 'ETT001')
 * @param {string} to       - Recipient email address
 * @param {object} data     - Placeholder values e.g. { supplierName, tenderTitle, orgName }
 */
async function sendTemplatedEmail(pool, sql, typeId, to, data = {}) {
    // Load the template from the database
    const result = await pool.request()
        .input('typeId', sql.VarChar(10), typeId)
        .query(`
            SELECT et.Subject, et.Body
            FROM EmailTemplate et
            WHERE et.TemplateTypeID = @typeId
        `);

    if (result.recordset.length === 0) {
        console.warn(`[mailer] No email template found for type: ${typeId}`);
        return;
    }

    const { Subject, Body } = result.recordset[0];

    const subject = interpolate(Subject, data);
    const text    = interpolate(Body, data);

    await transporter.sendMail({
        from: `"${data.orgName || 'Procurement Portal'}" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        text,
    });

    console.log(`[mailer] Email sent to ${to} (template: ${typeId})`);
}

module.exports = { sendTemplatedEmail };