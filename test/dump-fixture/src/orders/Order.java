package orders;

import java.math.BigDecimal;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;

@Data
@Slf4j
public class Order {
    private static final String PREFIX = "/api/" + "v1";
    private static final int LIMIT = 2 * 3 + 1;

    private Long id;
    private BigDecimal total;

    public String describe() {
        log.info("order {}", id);
        return PREFIX + id;
    }
}
