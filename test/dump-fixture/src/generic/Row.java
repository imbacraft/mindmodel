package generic;

import external.OrderState;

public class Row {
    private OrderState state;

    public void setState(OrderState state) {
        this.state = state;
    }

    // A status constant declared outside this checkout: the value is named, not dropped.
    public void revise() {
        this.state = OrderState.CANCELLED;
    }
}
