import {
    createStep,
    StepResponse,
    createWorkflow,
} from "@medusajs/workflows-sdk";
import { MedusaContainer } from "@medusajs/medusa/dist/types/global";
import { Logger } from "winston";
import OrderService from "../services/order";
import WalletPaymentProcessorService from "../services/wallet-payment-processor";
import WalletAccountTransactionRepository from "../repositories/wallet-account-transaction";
import WalletAccountRepository from "../repositories/wallet-account";
import UserRepository from "../repositories/user";
import WalletRepository from "../repositories/wallet";
import { WalletAccount } from "../models/wallet-account";
import { Order } from "../models/order";
import { Between, In } from "typeorm";
import { WalletAccountTransaction } from "../models/wallet-account-transaction";

type WorkflowInput = {
    store_id: string;
    admin_user_id: string;
};

type AuditResult = {
    processed_orders: number;
    fixed_transactions: number;
    verified_transactions: number;
    missing_transactions: number;
    balances: Record<string, { old: number; new: number }>;
    details: string[];
};

const auditWalletStep = createStep(
    "auditWalletStep",
    async (input: WorkflowInput, context) => {
        const container: MedusaContainer = context.container;
        const logger: Logger = container.resolve("logger");

        const orderService: OrderService = container.resolve("orderService");
        const walletPaymentProcessorService: WalletPaymentProcessorService = container.resolve("walletPaymentProcessorService");
        const walletAccountTransactionRepo = container.resolve<typeof WalletAccountTransactionRepository>("walletAccountTransactionRepository");
        const walletAccountRepo = container.resolve<typeof WalletAccountRepository>("walletAccountRepository");
        const userRepository = container.resolve<typeof UserRepository>("userRepository");
        const walletRepo = container.resolve<typeof WalletRepository>("walletRepository");

        const { store_id } = input;
        const details: string[] = [];

        logger.info(`[AuditWallet] Starting audit for store_id: ${store_id}`);

        const user = await userRepository.findOne({ where: { store_id } });
        if (!user) {
            logger.error(`[AuditWallet] No user found for store_id: ${store_id}`);
            throw new Error(`No user found for store_id: ${store_id}`);
        }

        const wallet = await walletRepo.findOne({ where: { user_id: user.id } });
        if (!wallet) {
            logger.error(`[AuditWallet] No wallet found for user: ${user.id}`);
            throw new Error(`No wallet found for user: ${user.id}`);
        }

        logger.info(`[AuditWallet] Found user ${user.id} and wallet ${wallet.id}`);

        const orders = await orderService.list(
            {
                // @ts-ignore
                store_id: store_id,
            },
            {
                select: [
                    'id',
                    'status',
                    'fulfillment_status',
                    'payment_status',
                    'display_id',
                    'cart_id',
                    'draft_order_id',
                    'customer_id',
                    'email',
                    'region_id',
                    'currency_code',
                    'tax_rate',
                    'canceled_at',
                    'created_at',
                    'updated_at',
                    'metadata',
                    'no_notification',
                    'sales_channel_id'
                ],
                relations: [
                    'items',
                    'swaps.additional_items',
                    'claims.additional_items',
                    'billing_address',
                    'claims',
                    'claims.additional_items.variant',
                    'claims.claim_items',
                    'claims.claim_items.images',
                    'claims.claim_items.item',
                    'claims.fulfillments',
                    'claims.fulfillments.tracking_links',
                    'claims.return_order',
                    'claims.return_order.shipping_method',
                    'claims.return_order.shipping_method.tax_lines',
                    'claims.shipping_address',
                    'claims.shipping_methods',
                    'customer',
                    'discounts',
                    'discounts.rule',
                    'fulfillments',
                    'fulfillments.items',
                    'fulfillments.tracking_links',
                    'gift_card_transactions',
                    'gift_cards',
                    'payments',
                    'refunds',
                    'region',
                    'returns',
                    'returns.items',
                    'returns.items.reason',
                    'returns.shipping_method',
                    'returns.shipping_method.shipping_option',
                    'returns.shipping_method.tax_lines',
                    'shipping_address',
                    'shipping_methods',
                    'shipping_methods.shipping_option',
                    'shipping_methods.tax_lines',
                    'swaps',
                    'swaps.additional_items.variant',
                    'swaps.fulfillments',
                    'swaps.fulfillments.tracking_links',
                    'swaps.payment',
                    'swaps.return_order',
                    'swaps.return_order.shipping_method',
                    'swaps.return_order.shipping_method.shipping_option',
                    'swaps.return_order.shipping_method.tax_lines',
                    'swaps.shipping_address',
                    'swaps.shipping_methods',
                    'swaps.shipping_methods.shipping_option',
                    'swaps.shipping_methods.tax_lines',
                    'sales_channel'
                ],
                skip: 0,


                take: 10000
            }
        );

        logger.info(`[AuditWallet] Processing ${orders.length} orders`);

        let fixedCount = 0;
        let verifiedCount = 0;
        let missingCount = 0;

        const walletAccounts: Record<string, WalletAccount> = {};

        for (const order of orders) {
            if (order.status === "canceled") continue;

            const currency = order.currency_code.toLowerCase(); // Medusa uses lowercase for currency codes

            // Log currency for debug
            // logger.info(`[AuditWallet] Order ${order.id} currency: ${currency}`);

            if (!walletAccounts[currency]) {
                const account = await walletAccountRepo.createQueryBuilder("wa")
                    .leftJoinAndSelect("wa.wallet", "w")
                    .where("w.user_id = :userId", { userId: user.id })
                    .andWhere("wa.currency = :currency", { currency: order.currency_code })
                    .getOne();

                if (account) {
                    walletAccounts[currency] = account;
                } else {
                    // Try uppercase fallback just in case
                    const accountUpper = await walletAccountRepo.createQueryBuilder("wa")
                        .leftJoinAndSelect("wa.wallet", "w")
                        .where("w.user_id = :userId", { userId: user.id })
                        .andWhere("wa.currency = :currency", { currency: order.currency_code.toUpperCase() })
                        .getOne();

                    if (accountUpper) {
                        walletAccounts[currency] = accountUpper;
                    }
                }
            }

            const account = walletAccounts[currency];
            if (!account) {
                logger.info(`[AuditWallet] No wallet account found for order ${order.id} (Currency: ${currency}). Creating new account...`);

                // Create new wallet account
                const newAccount = await walletAccountRepo.createAccount(user.id, currency);

                if (newAccount) {
                    walletAccounts[currency] = newAccount;
                    const msg = `Created new Wallet Account ${newAccount.id} for currency ${currency}`;
                    details.push(msg);
                    logger.info(`[AuditWallet] ${msg}`);
                    // Proceed with this new account
                } else {
                    const msg = `Failed to create wallet account for order ${order.id} (Currency: ${currency})`;
                    details.push(msg);
                    logger.error(`[AuditWallet] ${msg}`);
                    continue;
                }
            }

            // Re-assign account as it might be newly created
            const finalAccount = walletAccounts[currency];

            const expectedAmountMajor = order.total / 100;
            const orderTotalCents = order.total;

            let transaction = await walletAccountTransactionRepo.findOne({
                where: {
                    metadata: {
                        order_id: order.id
                    } as any
                }
            });

            if (!transaction) {
                // Try searching by exact amount match first (high confidence)
                const exactMatch = await walletAccountTransactionRepo.findOne({
                    where: {
                        wallet_account_id: finalAccount.id,
                        amount: expectedAmountMajor,
                        // Optionally filter by date window?
                    }
                });
                if (exactMatch) transaction = exactMatch;
            }

            if (!transaction) {
                const fuzzyTransactions = await walletAccountTransactionRepo.find({
                    where: [
                        {
                            wallet_account_id: finalAccount.id,
                            amount: orderTotalCents,
                        },
                        {
                            wallet_account_id: finalAccount.id,
                            amount: expectedAmountMajor,
                        }
                    ],
                    order: { created_at: "DESC" }
                });

                const potentialBug = fuzzyTransactions.find(t => Number(t.amount) === orderTotalCents);
                const potentialCorrect = fuzzyTransactions.find(t => Number(t.amount) === expectedAmountMajor);

                if (potentialBug) {
                    transaction = potentialBug;
                } else if (potentialCorrect) {
                    transaction = potentialCorrect;
                }
            }

            if (transaction) {
                let changed = false;

                if (Number(transaction.amount) === orderTotalCents) {
                    const oldAmt = transaction.amount;
                    transaction.amount = expectedAmountMajor;
                    changed = true;
                    const msg = `Fixed Transaction ${transaction.id} for Order ${order.id}. Amt: ${oldAmt} -> ${transaction.amount}`;
                    details.push(msg);
                    logger.info(`[AuditWallet] ${msg}`);
                    fixedCount++;
                } else {
                    verifiedCount++;
                }

                if (!transaction.metadata || !transaction.metadata.order_id) {
                    transaction.metadata = {
                        ...(transaction.metadata || {}),
                        order_id: order.id
                    };
                    changed = true;
                }

                if (changed) {
                    await walletAccountTransactionRepo.save(transaction);
                }
            } else {
                missingCount++;
                logger.info(`[AuditWallet] Missing transaction for Order ${order.id}. Creating new transaction...`);

                const newTransaction = walletAccountTransactionRepo.create({
                    wallet_account_id: finalAccount.id,
                    amount: expectedAmountMajor,
                    // currency_code removed
                    type: "credit",
                    status: "completed",
                    metadata: {
                        order_id: order.id,
                        is_audit_fix: true
                    }
                });

                await walletAccountTransactionRepo.save(newTransaction);

                const msg = `Created missing transaction ${newTransaction.id} for Order ${order.id}. Amt: ${expectedAmountMajor}`;
                details.push(msg);
                logger.info(`[AuditWallet] ${msg}`);

                // We don't increment fixedCount here, or maybe we do? 
                // It was "missing", now "fixed".
                fixedCount++;
                missingCount--; // adjust count since we fixed it
            }
        }

        logger.info(`[AuditWallet] Re-aggregating balances for ${Object.keys(walletAccounts).length} accounts`);
        const updatedBalances: Record<string, { old: number, new: number }> = {};
        const walletBalanceUpdates: Record<string, number> = {};

        for (const currency in walletAccounts) {
            const account = walletAccounts[currency];
            const oldBalance = account.balance;

            const { sum } = await walletAccountTransactionRepo
                .createQueryBuilder("wat")
                .select("SUM(wat.amount)", "sum")
                .where("wat.wallet_account_id = :id", { id: account.id })
                .andWhere("wat.status != :failed", { failed: "failed" })
                .getRawOne();

            const newBalance = parseFloat(sum) || 0;

            if (Number(account.balance) !== newBalance) {
                logger.info(`[AuditWallet] Updating account ${account.id} (${currency}) balance: ${oldBalance} -> ${newBalance}`);
                account.balance = newBalance;
                await walletAccountRepo.save(account);
            }
            updatedBalances[currency] = { old: Number(oldBalance), new: newBalance };
            walletBalanceUpdates[currency] = newBalance;
        }

        if (Object.keys(walletBalanceUpdates).length > 0) {
            let walletChanged = false;
            if (!wallet.total_balance || typeof wallet.total_balance !== 'object') {
                wallet.total_balance = {};
            }

            for (const [curr, bal] of Object.entries(walletBalanceUpdates)) {
                if (wallet.total_balance[curr] !== bal) {
                    wallet.total_balance[curr] = bal;
                    walletChanged = true;
                }
            }

            if (walletChanged) {
                await walletRepo.save(wallet);
                logger.info(`[AuditWallet] Updated Wallet total_balance for store ${store_id}`);
                details.push(`Updated Wallet Total Balance for currencies: ${Object.keys(walletBalanceUpdates).join(", ")}`);
            }
        }

        logger.info(`[AuditWallet] Audit complete for store ${store_id}. Fixed: ${fixedCount}, Verified: ${verifiedCount}, Missing: ${missingCount}`);

        return new StepResponse({
            processed_orders: orders.length,
            fixed_transactions: fixedCount,
            verified_transactions: verifiedCount,
            missing_transactions: missingCount,
            balances: updatedBalances,
            details
        });
    }
);

const auditWalletWorkflow = createWorkflow<WorkflowInput, AuditResult>(
    "audit-wallet-workflow",
    function (input) {
        return auditWalletStep(input);
    }
);

export default auditWalletWorkflow;