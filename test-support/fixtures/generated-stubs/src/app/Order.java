package app;

import java.math.BigDecimal;

public class Order {
    private Long id;
    private String name;
    private BigDecimal total;

    public Long getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public BigDecimal getTotal() {
        return total;
    }
}
