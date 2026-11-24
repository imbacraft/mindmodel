package shop;

public class OrderService {
    // A switch result assigned to a local that the setter then writes: the arms are the values set here.
    public Order create(Pricing pricing) {
        Order row = new Order();
        OrderStatus initial = switch (pricing) {
            case FIXED -> OrderStatus.PAID;
            case FREE -> OrderStatus.PENDING;
        };
        row.setStatus(initial);
        return row;
    }

    // A helper returns the enum: the constant is chosen there, and handed to the setter here.
    public Order createWithHelper(Pricing pricing) {
        Order row = new Order();
        row.setStatus(resolveInitial(pricing));
        return row;
    }

    private OrderStatus resolveInitial(Pricing pricing) {
        return switch (pricing) {
            case FIXED -> OrderStatus.PAID;
            default -> OrderStatus.PENDING;
        };
    }

    // A parameter followed to its caller: the callee writes the field, the caller names the constant.
    public void change(Order order, OrderStatus next) {
        order.setStatus(next);
    }

    public void promote(Order order) {
        change(order, OrderStatus.PAID);
    }

    // A reader names no constant: it must not become a set site.
    public OrderStatus current(Order order) {
        return order.getStatus();
    }

    // Another status enum is another lifecycle, whatever this method returns.
    public OtherStatus other() {
        return OtherStatus.OPEN;
    }

    // A switch result nothing sets: the value is chosen, but no status write consumes it.
    public StageStatus stage(boolean live) {
        return live ? StageStatus.LIVE : StageStatus.DRAFT;
    }
}
