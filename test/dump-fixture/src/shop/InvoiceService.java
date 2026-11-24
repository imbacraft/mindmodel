package shop;

public class InvoiceService {
    // The same enum as Order, a different entity: the receiver decides which lifecycle this write belongs to.
    public void activate(Invoice invoice) {
        invoice.setStatus(OrderStatus.PAID);
    }
}
